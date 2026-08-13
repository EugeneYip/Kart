/**
 * ============================================================================
 *  APEX KART — TERRAIN
 * ============================================================================
 *  One draw call of ground, out to 900 m, with sub-metre detail underfoot.
 *
 *  The heavy lifting happens in TerrainField (WorldTextures.ts): an fbm
 *  heightfield with the *road corridor already blended in*, baked to a float
 *  texture. Terrain then draws a single radially-warped grid that follows the
 *  camera and reads its Y from that texture in the vertex shader. Because the
 *  road is part of the field, terrain physically cannot gap or float relative
 *  to the road — the classic failure mode is designed out rather than tuned out.
 *
 *  Surfacing is a 4-layer height-blended splat (grass / dirt / rock / sand)
 *  driven by slope, altitude, moisture and macro noise, with a biplanar rock
 *  projection so cliffs don't smear, plus a 4x detail normal.
 *
 *  Ground self-shadowing comes from an 8-tap march through the height texture
 *  toward the sun, which gives long, soft hill shadows for free — much cheaper
 *  than spending a shadow cascade on 900 m of dirt.
 * ============================================================================
 */

import * as THREE from 'three';
import type { FrameContext, ISubsystem, QualitySettings } from '@/core/Types';
import { RENDER_ORDER } from '@/core/Config';
import { Rng } from '@/core/MathUtils';
import {
  GLSL_FIELD, GLSL_FIELD_EDGE, GLSL_FIELD_SHADOW_LOD, GLSL_NOISE, GLSL_SRGB,
  fieldUniforms, makeDetailNormal, makeTerrainLayers,
  type TerrainField, type TerrainLayerSet, type WorldTheme,
  worldFogUniforms,
} from './WorldTextures';

/** Per-theme surfacing constants: tile sizes, roughness and the sand band. */
interface ThemeSurface {
  /** metres per tile of the layer textures */
  tile: number;
  /** roughness per layer: grass, dirt, rock, sand */
  rough: THREE.Vector4;
  /** layer weight bias: grass, dirt, rock, sand */
  bias: THREE.Vector4;
  /**
   * Per-layer normal amplitude: grass, dirt, rock, sand. Multiplied by
   * `uNormalStrength` on top of the bake-time Sobel strength (`LAYER_SOBEL` in
   * WorldTextures). Dirt and sand are pulled down hard here — a review measured
   * the off-road shoulder at roughly 5x too strong, reading as corduroy at noon
   * and as orange tiger stripes at sunset.
   */
  normalScale: THREE.Vector4;
  /** sand appears below sandTop and fades over sandFade metres */
  sandTop: number;
  sandFade: number;
  detailScale: number;
}

const THEME_SURFACE: Record<WorldTheme, ThemeSurface> = {
  meadow: {
    tile: 9, rough: new THREE.Vector4(0.86, 0.90, 0.74, 0.92),
    bias: new THREE.Vector4(0.55, 0.18, 0.0, -0.9),
    normalScale: new THREE.Vector4(1.0, 0.55, 1.0, 0.5),
    sandTop: -1e5, sandFade: 6, detailScale: 4,
  },
  coastal: {
    tile: 8.5, rough: new THREE.Vector4(0.84, 0.90, 0.70, 0.86),
    bias: new THREE.Vector4(0.42, 0.14, 0.0, 0.15),
    normalScale: new THREE.Vector4(1.0, 0.55, 1.0, 0.55),
    sandTop: 3.2, sandFade: 5.5, detailScale: 4.5,
  },
  city: {
    tile: 7.5, rough: new THREE.Vector4(0.88, 0.92, 0.76, 0.92),
    bias: new THREE.Vector4(0.48, 0.34, 0.0, -0.8),
    normalScale: new THREE.Vector4(1.0, 0.55, 1.0, 0.5),
    sandTop: -1e5, sandFade: 6, detailScale: 4,
  },
  volcano: {
    tile: 8, rough: new THREE.Vector4(0.78, 0.86, 0.56, 0.84),
    bias: new THREE.Vector4(0.30, 0.34, 0.22, -0.5),
    normalScale: new THREE.Vector4(0.85, 0.65, 1.15, 0.55),
    sandTop: -1e5, sandFade: 6, detailScale: 5,
  },
  desert: {
    tile: 10, rough: new THREE.Vector4(0.90, 0.92, 0.74, 0.88),
    bias: new THREE.Vector4(-0.35, 0.30, 0.0, 0.85),
    normalScale: new THREE.Vector4(1.0, 0.55, 1.0, 0.55),
    sandTop: 1e5, sandFade: 40, detailScale: 5,
  },
  snow: {
    tile: 9.5, rough: new THREE.Vector4(0.62, 0.90, 0.70, 0.70),
    bias: new THREE.Vector4(0.85, 0.05, 0.05, -0.9),
    normalScale: new THREE.Vector4(0.7, 0.55, 1.0, 0.45),
    sandTop: -1e5, sandFade: 6, detailScale: 4,
  },
};

const RES_FOR_TIER: Record<string, number> = { low: 129, medium: 161, high: 193, ultra: 225 };

/** Radial warp: dense underfoot, coarse at the horizon. */
const WARP_LINEAR = 0.062;
const HALF_EXTENT = 900;

/**
 * How the clipmap is cut into cullable pieces: radial band boundaries in metres
 * from the camera, and how many angular sectors each band is divided into.
 *
 * The grid is a 1800 m square centred on the camera, so a 65° vertical FOV at
 * 16:9 (97° horizontal) can only ever see about 27 % of its azimuth — the rest
 * is behind and beside you. As ONE mesh none of that could be culled: three
 * tests `geometry.boundingSphere`, and a sphere centred on the camera always
 * intersects the frustum. Cut into wedges, each wedge gets a sphere that is
 * genuinely somewhere, and the ones behind you fail the test.
 *
 * The innermost band is one disc rather than a fan: sectors that converge on the
 * camera all touch the near plane, so splitting them buys nothing.
 *
 * These numbers are the measured knee of the trade curve, not a guess.
 * `.probe-tmp/g5.ts` sweeps configurations against the real poses; on neon the
 * marginal return collapses right here:
 *
 *      chunks   submitted calls   submitted tris (of 100 352)
 *           1              1.0    100 %      <- one uncullable mesh, today
 *           9              6.4     76 %      <- this config, 4.4k tris per call
 *          13              8.6     73 %         1.4k tris per extra call
 *          23             14.2     66 %         1.3k
 *          43             20.5     54 %         1.7k
 *
 * Finer splits keep paying in triangles but the exchange rate falls by 3x, and a
 * draw call is not free: three's per-object cost is real CPU, and terrain is in
 * three passes a frame. If a browser `__QA__.benchmark(5)` ever shows the frame
 * is vertex-bound rather than fill-bound, raise the sector count here — it is one
 * constant and the probe re-proves the bounds.
 */
const GRID_BANDS: readonly number[] = [0, 150, Infinity];
const GRID_SECTORS: readonly number[] = [1, 8];

export class Terrain implements ISubsystem {
  readonly group = new THREE.Group();
  /** Cullable clipmap sectors. `chunks[0]` is the always-visible centre disc. */
  readonly chunks: THREE.Mesh[] = [];
  mountains: THREE.Mesh | null = null;
  material!: THREE.MeshStandardMaterial;

  /** Last perspective camera that drew us — used when nothing wires setCamera. */
  camera: THREE.PerspectiveCamera | null = null;

  private scene: THREE.Scene;
  private field: TerrainField;
  private theme: WorldTheme;
  private quality: QualitySettings;
  private layers: TerrainLayerSet | null = null;
  private detail: THREE.DataTexture | null = null;
  private surface: ThemeSurface;
  private uniforms: Record<string, THREE.IUniform> = {};
  private disposables: Array<{ dispose(): void }> = [];
  /** The clipmap's follow pivot. Every sector is a child at local identity. */
  private clipmap = new THREE.Group();
  /** Master vertex buffer the sectors share; only their index buffers differ. */
  private gridGeometry: THREE.BufferGeometry | null = null;
  /**
   * Sector culling is armed by the first `update()`, never at build time.
   * The pivot is placed from the camera, and three culls against the pivot
   * position established BEFORE the pass starts (`projectObject` runs before any
   * `onBeforeRender`). If culling were live from frame zero and `update()` never
   * ran, the pivot would sit at the world origin, every sector's bounds would be
   * out of frustum, no sector would draw, no `onBeforeRender` would fire to
   * re-centre it — and the ground would be permanently invisible. Latching here
   * means the worst case is exactly today's behaviour: uncullable but correct.
   */
  private culling = false;

  constructor(
    scene: THREE.Scene,
    field: TerrainField,
    theme: WorldTheme,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.field = field;
    this.theme = theme;
    this.quality = quality;
    this.surface = THEME_SURFACE[theme] ?? THEME_SURFACE.meadow;
  }

  async init(): Promise<void> {
    const size = this.quality.tier === 'low' ? 192 : 256;
    this.layers = makeTerrainLayers(size, this.theme);
    this.detail = makeDetailNormal(this.quality.tier === 'low' ? 128 : 256);
    this.disposables.push(this.layers, this.detail);

    this.group.name = 'Terrain';
    this.scene.add(this.group);

    this.buildMaterial();
    this.buildGrid();
    this.buildMountainRing();
  }

  // -------------------------------------------------------------------------

  private buildMaterial(): void {
    const s = this.surface;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0,
      dithering: true,
      fog: true,
    });
    mat.name = 'TerrainSplat';
    // Distinct cache key so this shader is never confused with the mountains'.
    mat.customProgramCacheKey = () => 'apex-terrain-splat';

    const fu = fieldUniforms(this.field);
    const u: Record<string, THREE.IUniform> = {
      uFieldHeight: fu.uFieldHeight,
      uFieldData: fu.uFieldData,
      uFieldEdge: { value: this.field.edgeTex },
      uFieldXform: fu.uFieldXform,
      uSunDirection: worldFogUniforms.uSunDirection,
      uLayerAlbedo: { value: this.layers ? this.layers.albedo : null },
      uLayerNormal: { value: this.layers ? this.layers.normal : null },
      uDetailNormal: { value: this.detail },
      uTile: { value: 1 / s.tile },
      uDetailTile: { value: s.detailScale / s.tile },
      uRough: { value: s.rough.clone() },
      uBias: { value: s.bias.clone() },
      uNormalScale: { value: s.normalScale.clone() },
      uSandBand: { value: new THREE.Vector2(s.sandTop, s.sandTop + s.sandFade) },
      // Was 1.15 on top of a flat Sobel strength of 2.0. Together with the
      // per-layer scales above and the softer bake this takes the off-road
      // shoulder from an effective 2.30 to 0.40 — 5.7x weaker — while grass and
      // rock keep about half of their old relief.
      uNormalStrength: { value: 0.85 },
      uWaterLevel: { value: this.field.waterLevel },
      uAoStrength: { value: 0.85 },
      uMacroTint: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.uniforms = u;

    mat.onBeforeCompile = (shader) => {
      for (const k in u) shader.uniforms[k] = u[k];

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_FIELD}
${GLSL_FIELD_EDGE}
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
varying vec4 vTerrData;
varying vec2 vTerrEdge;
`)
        .replace('#include <beginnormal_vertex>', /* glsl */ `
#include <beginnormal_vertex>
vec2 tWxz = ( modelMatrix * vec4( position, 1.0 ) ).xz;
objectNormal = fieldNormal( tWxz, uFieldXform.w );
`)
        .replace('#include <begin_vertex>', /* glsl */ `
#include <begin_vertex>
float tH = fieldHeight( tWxz );
transformed.y = tH;
vTerrWorld = vec3( tWxz.x, tH, tWxz.y );
vTerrNormal = objectNormal;
vTerrData = fieldData( tWxz );
// Road-edge signed distance (metres, + inside the corridor) and wide concavity.
// Sampled here rather than per fragment: it is baked at ~2.4 m per texel and the
// grid is finer than that near the camera, so the interpolant is exact where it
// matters and costs the fragment shader nothing.
vec2 tEdge = fieldEdgeRaw( tWxz );
vTerrEdge = vec2( ( tEdge.x - 0.5 ) * 48.0, tEdge.y );
`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_FIELD}
${GLSL_FIELD_SHADOW_LOD}
${GLSL_NOISE}
${GLSL_SRGB}
uniform sampler2DArray uLayerAlbedo;
uniform sampler2DArray uLayerNormal;
uniform sampler2D uDetailNormal;
uniform float uTile;
uniform float uDetailTile;
uniform vec4 uRough;
uniform vec4 uBias;
uniform vec4 uNormalScale;
uniform vec2 uSandBand;
uniform float uNormalStrength;
uniform float uWaterLevel;
uniform float uAoStrength;
uniform vec3 uMacroTint;
uniform vec3 uSunDirection;
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
varying vec4 vTerrData;
varying vec2 vTerrEdge;

/** Both projections' derivatives, computed once outside every gated tap. */
struct TerrGrad { vec2 fx; vec2 fy; vec2 wx; vec2 wy; };

/**
 * One layer of the splat, biplanar.
 *
 * On a slope the flat XZ projection stretches the texture into vertical smears,
 * so the dominant wall plane is blended in by steepness. textureGrad rather than
 * an implicit fetch because these taps live inside non-uniform branches, where
 * implicit derivatives are undefined — and unlike textureLod it keeps
 * anisotropic filtering, which is exactly what holds ground detail together at
 * the grazing angles a 1.2 m driver's eye gives you.
 */
vec4 layerAlbedo(float L, vec2 uv, vec2 wuv, TerrGrad g, float wall){
  vec4 c = textureGrad( uLayerAlbedo, vec3( uv, L ), g.fx, g.fy );
  if ( wall > 0.02 ) {
    c = mix( c, textureGrad( uLayerAlbedo, vec3( wuv, L ), g.wx, g.wy ), wall );
  }
  return c;
}

vec3 layerNormal(float L, vec2 uv, vec2 wuv, TerrGrad g, float wall){
  vec3 n = textureGrad( uLayerNormal, vec3( uv, L ), g.fx, g.fy ).xyz * 2.0 - 1.0;
  if ( wall > 0.30 ) {
    vec3 nw = textureGrad( uLayerNormal, vec3( wuv, L ), g.wx, g.wy ).xyz * 2.0 - 1.0;
    n = mix( n, nw, wall );
  }
  return n;
}
`)
        // ---- albedo -------------------------------------------------------
        .replace('#include <map_fragment>', /* glsl */ `
vec3 tWN = normalize( vTerrNormal );
float steepRaw = 1.0 - clamp( tWN.y, 0.0, 1.0 );
float steep = smoothstep( 0.14, 0.52, steepRaw );
float tDist = distance( vTerrWorld, cameraPosition );

// ---- multi-scale procedural detail --------------------------------------
// Four analytic bands at ~238 m / 38 m / 7.7 m / 1.9 m. This is the layer that
// makes the ground hold detail at range: the 8.5 m tiled albedo has mipped to
// near its mean by 60 m, but noise evaluated from world position has no mip chain
// and still resolves past 200 m. Only the finest band is fine enough to shimmer,
// so only it is faded (95 m -> 165 m).
float tMacroBig = fbm2( vTerrWorld.xz * 0.0042, 2 );
float tMacro    = fbm2( vTerrWorld.xz * 0.026, 3 );
float tMid      = fbm2( vTerrWorld.xz * 0.130, 2 );
float fineFade  = 1.0 - smoothstep( 95.0, 165.0, tDist );
float tFine     = 0.5;
if ( fineFade > 0.004 ) tFine = fbm2( vTerrWorld.xz * 0.52, 2 );
// Concavity at ~29 m, baked. Dirt collects in hollows, dry aggregate sits on
// ridges — macro variation that follows the shape of the land instead of sitting
// on top of it as obvious noise.
float valley = ( vTerrEdge.y - 0.5 ) * 2.0;

// ---- tile coordinates ----------------------------------------------------
// Low-frequency domain warp. The layer textures repeat every ~8.5 m and a
// straight world-space UV makes that repeat countable; a 74 m warp of half a tile
// shears the lattice continuously while perturbing the mip derivative by ~6 %.
vec2 tuv = vTerrWorld.xz * uTile;
tuv += vec2( vnoise2( vTerrWorld.xz * 0.0135 ), vnoise2( vTerrWorld.xz * 0.0135 + 31.7 ) ) * 0.55;
vec2 tWallUv = ( abs( tWN.x ) > abs( tWN.z ) )
  ? vec2( vTerrWorld.z, vTerrWorld.y ) * uTile
  : vec2( vTerrWorld.x, vTerrWorld.y ) * uTile;
TerrGrad tg = TerrGrad( dFdx( tuv ), dFdy( tuv ), dFdx( tWallUv ), dFdy( tWallUv ) );

// ---- boundaries: noise-broken, never clipped -----------------------------
// vTerrData.r is the old near-binary road mask: a 3.4 m ramp sampled at 2.4 m per
// texel, i.e. 1.4 texels, so bilinear reconstruction of it is a staircase of
// 2.4 m blocks. That staircase *is* the sawtooth material boundary. This uses the
// baked signed distance instead and displaces the crossing by up to ±2.4 m of
// noise at two scales, so the layers interpenetrate along an irregular front.
float edgeM = vTerrEdge.x + ( tMid - 0.5 ) * 3.2 + ( tFine - 0.5 ) * 1.6 * fineFade;
float road  = smoothstep( -1.4, 1.4, edgeM );
// A second, much wider and independently broken band of dust and wear, so the
// transition has structure at 16 m as well as at 1 m.
float wear  = smoothstep( -16.0, 0.0, vTerrEdge.x + ( tMacro - 0.5 ) * 11.0 );
// The sand band was a pure altitude threshold, which draws a contour line across
// the beach — the grass/sand half of the same defect. Perturbing the altitude
// interdigitates the two layers instead.
float altN  = vTerrWorld.y + ( tMacro - 0.5 ) * 3.0 + ( tMid - 0.5 ) * 1.3;
float sandM = 1.0 - smoothstep( uSandBand.x, uSandBand.y, altN );

// ---- layer weights -------------------------------------------------------
float tMoist = vTerrData.b;
float tRockD = vTerrData.a;
vec4 tW;
tW.x = ( 0.22 + tMoist * 1.15 ) * ( 1.0 - steep ) * ( 1.0 - sandM * 0.9 ) + uBias.x + valley * 0.10;
tW.y = 0.26 + ( 1.0 - tMoist ) * 0.80 + road * 1.35 + wear * 0.30 + tMacro * 0.45 + uBias.y - valley * 0.06;
tW.z = steep * 2.05 + tRockD * 1.15 - 0.28 + uBias.z - valley * 0.16;
tW.w = sandM * 2.25 + uBias.w;
tW = max( tW, vec4( 0.0 ) ) + vec4( 1e-4 );

// ---- height blend, with the dead taps skipped ----------------------------
// A layer whose analytic weight is more than (height influence + band) below the
// leader mathematically cannot win the blend, so its fetches are dead work. Two
// or three of the four are normally skipped, which is what pays for the noise
// above — the old code always took four albedo taps plus up to four normal taps.
float wMax = max( max( tW.x, tW.y ), max( tW.z, tW.w ) );
float wCut = wMax - 0.84;
vec4 tHeights = vec4( -1e3 );
vec3 tC0 = vec3( 0.0 ), tC1 = vec3( 0.0 ), tC2 = vec3( 0.0 ), tC3 = vec3( 0.0 );
if ( tW.x > wCut ) { vec4 t = layerAlbedo( 0.0, tuv, tWallUv, tg, steep ); tC0 = t.rgb; tHeights.x = t.a; }
if ( tW.y > wCut ) { vec4 t = layerAlbedo( 1.0, tuv, tWallUv, tg, steep ); tC1 = t.rgb; tHeights.y = t.a; }
if ( tW.z > wCut ) { vec4 t = layerAlbedo( 2.0, tuv, tWallUv, tg, steep ); tC2 = t.rgb; tHeights.z = t.a; }
if ( tW.w > wCut ) { vec4 t = layerAlbedo( 3.0, tuv, tWallUv, tg, steep ); tC3 = t.rgb; tHeights.w = t.a; }

// The layer with the tallest local features wins, so gravel pokes through grass
// along a ragged front rather than crossfading. 0.70 of height against a 0.14
// band is a sharper interpenetration than the old 0.55/0.16.
vec4 hw = tHeights * 0.70 + tW;
float hmax = max( max( hw.x, hw.y ), max( hw.z, hw.w ) );
vec4 b = max( hw - ( hmax - 0.14 ), vec4( 0.0 ) );
b /= ( b.x + b.y + b.z + b.w );

vec3 tAlb = tC0 * b.x + tC1 * b.y + tC2 * b.z + tC3 * b.w;
tAlb = srgbToLin( tAlb );
// Four bands of drift, each centred on 1.0 so the exposure sits where the grade
// expects it. Together they mean no two square metres of ground match.
tAlb *= mix( vec3( 0.80, 0.86, 0.78 ), vec3( 1.16, 1.10, 1.06 ), tMacroBig );
tAlb *= mix( 0.89, 1.11, tMacro );
tAlb *= mix( 0.91, 1.09, tMid );
tAlb *= mix( 1.0, mix( 0.88, 1.12, tFine ), fineFade );
tAlb *= mix( vec3( 1.04, 1.01, 0.95 ), vec3( 0.95, 0.98, 0.95 ), clamp( valley * 0.5 + 0.5, 0.0, 1.0 ) );
tAlb *= uMacroTint;
// Wet band right at the shoreline.
float wet = 1.0 - smoothstep( 0.0, 1.8, vTerrWorld.y - uWaterLevel );
tAlb *= mix( 1.0, 0.52, wet );
float tAo = mix( 1.0, vTerrData.g, uAoStrength );
diffuseColor.rgb *= tAlb * tAo;
`)
        // ---- normals ------------------------------------------------------
        .replace('#include <normal_fragment_maps>', /* glsl */ `
// The height blend is sparse: after the band clamp, usually one or two layers
// have any weight at all. Skipping the zero-weight normal taps is worth real
// milliseconds on a surface this size, and neighbouring pixels take the same
// branch, so the divergence cost is nil. Each layer carries its own amplitude —
// dirt and sand want a fraction of what rock and grass want.
vec3 tN = vec3( 0.0 );
if ( b.x > 0.004 ) tN += layerNormal( 0.0, tuv, tWallUv, tg, steep ) * ( b.x * uNormalScale.x );
if ( b.y > 0.004 ) tN += layerNormal( 1.0, tuv, tWallUv, tg, steep ) * ( b.y * uNormalScale.y );
if ( b.z > 0.004 ) tN += layerNormal( 2.0, tuv, tWallUv, tg, steep ) * ( b.z * uNormalScale.z );
if ( b.w > 0.004 ) tN += layerNormal( 3.0, tuv, tWallUv, tg, steep ) * ( b.w * uNormalScale.w );
// The detail normal tiles at ~2 m, which is sub-pixel past 130 m — it would mip
// to flat and alias on the way there. Rather than fade it out and leave distant
// ground with no relief at all, its scale is walked out to ~10 m features with
// distance. Same single tap, but the ground still has *lit* relief at 100 m+
// instead of only albedo variation, which is the whole point of the exercise.
float tFar = smoothstep( 40.0, 165.0, tDist );
vec3 dN = texture( uDetailNormal, vTerrWorld.xz * uDetailTile * mix( 1.0, 0.21, tFar ) ).xyz * 2.0 - 1.0;
tN.xy += dN.xy * mix( 0.50, 0.30, tFar );

vec3 wT = normalize( cross( vec3( 0.0, 1.0, 0.0 ), tWN ) + vec3( 1e-5, 0.0, 1e-5 ) );
vec3 wB = cross( tWN, wT );
// Relief varies with the 7.7 m band, so the surface is not uniformly bumpy —
// smooth swept patches next to rougher ones is what reads as real ground.
float ns = uNormalStrength * mix( 1.0, 0.35, wet ) * mix( 0.78, 1.22, tMid );
vec3 pert = normalize( tWN + wT * tN.x * ns + wB * tN.y * ns );
normal = normalize( ( viewMatrix * vec4( pert, 0.0 ) ).xyz );
`)
        // ---- roughness ----------------------------------------------------
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
float roughnessFactor = dot( uRough, b );
roughnessFactor *= mix( 1.0, 0.34, wet );
roughnessFactor = clamp(
  roughnessFactor + ( tMacro - 0.5 ) * 0.10 + ( tMid - 0.5 ) * 0.07, 0.05, 1.0 );
`)
        // ---- heightfield self shadow --------------------------------------
        .replace('#include <lights_fragment_begin>', /* glsl */ `
float terrainSun = fieldShadowLod(
  vTerrWorld + vec3( 0.0, 0.35, 0.0 ), uSunDirection,
  distance( vTerrWorld, cameraPosition ), 150.0 );
// lights_pars_begin already gave this a 1.0 fallback; take it over.
#undef CSM_EXTRA_SHADOW
#define CSM_EXTRA_SHADOW terrainSun
#include <lights_fragment_begin>
`);
    };

    this.material = mat;
  }

  // -------------------------------------------------------------------------

  private buildGrid(): void {
    const res = RES_FOR_TIER[this.quality.tier] ?? 193;
    const cells = res - 1;
    const verts = res * res;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);

    const warp = (t: number): number => {
      const a = Math.abs(t);
      const w = WARP_LINEAR * a + (1 - WARP_LINEAR) * a * a * a;
      return Math.sign(t) * w * HALF_EXTENT;
    };

    let p = 0, q = 0;
    for (let j = 0; j < res; j++) {
      const v = (j / cells) * 2 - 1;
      const z = warp(v);
      for (let i = 0; i < res; i++) {
        const u = (i / cells) * 2 - 1;
        pos[p] = warp(u);
        pos[p + 1] = 0;
        pos[p + 2] = z;
        nrm[p] = 0; nrm[p + 1] = 1; nrm[p + 2] = 0;
        p += 3;
        uv[q] = i / cells; uv[q + 1] = j / cells; q += 2;
      }
    }

    const idx = new Uint32Array(cells * cells * 6);
    let k = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = j * res + i;
        const b = a + 1;
        const c = a + res;
        const d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), HALF_EXTENT * 1.5);
    this.gridGeometry = geo;

    this.clipmap.name = 'TerrainClipmap';
    this.group.add(this.clipmap);

    // Vertical extent of a sector's bounds. The vertex shader overwrites
    // `transformed.y` with `fieldHeight(worldXZ)` — an ABSOLUTE world height, and
    // the pivot's y is 0, so a sector's local Y range is the field's own height
    // range. The height texture is ClampToEdge, so sampling past the baked square
    // still returns a value inside [minHeight, maxHeight]; there is nowhere the
    // surface can go that this misses. Deliberately the field's *global* range
    // rather than a per-sector one: a per-sector range would have to be recomputed
    // every frame as the pivot moves, and getting it wrong punches a hole in the
    // ground. Vertical slack costs almost nothing anyway — the azimuth is what
    // does the culling, and a sector behind you is behind you at every height.
    const yMin = this.field.minHeight - 2;
    const yMax = this.field.maxHeight + 2;

    const sectors = splitClipmapGrid(geo, GRID_BANDS, GRID_SECTORS, yMin, yMax);
    for (let i = 0; i < sectors.length; i++) {
      const mesh = new THREE.Mesh(sectors[i], this.material);
      mesh.name = i === 0 ? 'TerrainGrid' : `TerrainGrid.s${i}`;
      // Armed by `update()`; see the `culling` field.
      mesh.frustumCulled = false;
      mesh.castShadow = false;    // the field-march handles ground self-shadow
      mesh.receiveShadow = true;
      mesh.renderOrder = RENDER_ORDER.TERRAIN;
      mesh.matrixAutoUpdate = false;
      this.chunks.push(mesh);
      this.clipmap.add(mesh);
    }

    // Self-position: the terrain must be centred on whatever perspective camera
    // is drawing it (main view, or a mirrored water-reflection camera). Only the
    // centre disc carries this — it is the sector that can never be culled while
    // the camera is anywhere near the ground, so it is the one that will always
    // get the callback. Both cameras that draw terrain share the same x/z (the
    // reflection camera is mirrored in Y only), so the pivot never moves
    // mid-pass, which would otherwise draw sectors at a position they were not
    // culled against.
    const centre = this.chunks[0];
    if (centre) {
      centre.onBeforeRender = (_r, _s, cam) => {
        const pc = cam as THREE.PerspectiveCamera;
        if (!pc.isPerspectiveCamera) return;
        if (!pc.userData.apxReflectionCam) this.camera = pc;
        this.recentre(pc.position.x, pc.position.z);
      };
    }
  }

  /** Slide the clipmap pivot under a camera. Cheap and idempotent. */
  private recentre(x: number, z: number): void {
    const p = this.clipmap.position;
    if (p.x === x && p.z === z) return;
    p.set(x, 0, z);
    this.clipmap.updateMatrix();
    this.clipmap.updateMatrixWorld(true);
  }

  // -------------------------------------------------------------------------

  /**
   * Static distant relief. Sampling the analytic field beyond the baked square
   * gives a silhouette that agrees with the near terrain; the inner rim is sunk
   * so it can never peek above the clipmap.
   */
  private buildMountainRing(): void {
    const field = this.field;
    const inner = HALF_EXTENT * 0.78;
    const outer = HALF_EXTENT * 2.6;
    const radials = 220;
    const rings = 16;
    const verts = radials * rings;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const rng = new Rng(field.seed ^ 0x5eed);

    const snowLine = this.theme === 'snow' ? 40 : 175;
    const baseA = new THREE.Color();
    const baseB = new THREE.Color();
    switch (this.theme) {
      case 'volcano': baseA.setHex(0x2a1a18); baseB.setHex(0x120b0c); break;
      case 'desert': baseA.setHex(0x9a6f45); baseB.setHex(0x6d4a30); break;
      case 'snow': baseA.setHex(0x7d8ba0); baseB.setHex(0xdfe9f5); break;
      case 'city': baseA.setHex(0x4a5560); baseB.setHex(0x2e3742); break;
      default: baseA.setHex(0x51684a); baseB.setHex(0x3a4a56); break;
    }
    const c = new THREE.Color();

    for (let r = 0; r < rings; r++) {
      const tr = r / (rings - 1);
      const rad = inner + (outer - inner) * Math.pow(tr, 1.45);
      // Big amplitude in the middle rings makes a proper mountain silhouette.
      const relief = Math.sin(Math.PI * Math.min(1, tr * 1.25)) * 1.0;
      for (let a = 0; a < radials; a++) {
        const ta = (a / radials) * Math.PI * 2;
        const jx = rng.range(-1, 1) * (rad * 0.012);
        const jz = rng.range(-1, 1) * (rad * 0.012);
        const x = field.centreX + Math.cos(ta) * rad + jx;
        const z = field.centreZ + Math.sin(ta) * rad + jz;
        let y = field.naturalHeightAt(x, z);
        y += relief * (field.amplitude * 5.0 + 120) *
          Math.pow(Math.max(0, 0.5 + 0.5 * Math.sin(ta * 3.1 + rad * 0.004)), 1.4) * 0.55;
        if (r === 0) y -= 55; // bury the inner rim under the clipmap
        const i3 = (r * radials + a) * 3;
        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        nrm[i3] = 0; nrm[i3 + 1] = 1; nrm[i3 + 2] = 0;

        const t = Math.min(1, Math.max(0, (y - 20) / 220));
        c.copy(baseA).lerp(baseB, t * 0.85);
        if (y > snowLine) {
          const sn = Math.min(1, (y - snowLine) / 110);
          c.lerp(_snow, sn * 0.9);
        }
        col[i3] = c.r; col[i3 + 1] = c.g; col[i3 + 2] = c.b;
      }
    }

    const idx: number[] = [];
    for (let r = 0; r < rings - 1; r++) {
      for (let a = 0; a < radials; a++) {
        const a2 = (a + 1) % radials;
        const i0 = r * radials + a;
        const i1 = r * radials + a2;
        const i2 = (r + 1) * radials + a;
        const i3 = (r + 1) * radials + a2;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: false,
      fog: true,
      dithering: true,
    });
    mat.name = 'MountainRing';
    mat.customProgramCacheKey = () => 'apex-mountains';

    // This material used to be `vertexColors: true` and nothing else — no map, no
    // normal detail — so every hillside was one flat Lambert wash at every
    // distance, which is most of why surface detail scored 3/10. It gets a
    // procedural rock surface instead of a texture: the ring sits 700–2300 m out,
    // where a tiled map would be far past its last mip, but analytic noise has no
    // mip chain and 20–90 m features are exactly what reads at that range.
    const snowy = this.theme !== 'volcano' && this.theme !== 'desert';
    const mtnU: Record<string, THREE.IUniform> = {
      uSnowBand: { value: new THREE.Vector2(snowLine * 0.86, snowLine + 90) },
      uSnowAmt: { value: snowy ? (this.theme === 'snow' ? 0.72 : 0.5) : 0.0 },
      uSnowColor: { value: new THREE.Color(0xdce6f6) },
      uRockContrast: { value: this.theme === 'volcano' ? 0.34 : 0.24 },
    };
    mat.onBeforeCompile = (shader) => {
      for (const k in mtnU) shader.uniforms[k] = mtnU[k];

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
#include <common>
varying vec3 vMtnWorld;
varying vec3 vMtnNormal;
`)
        .replace('#include <begin_vertex>', /* glsl */ `
#include <begin_vertex>
vMtnWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
vMtnNormal = normalize( mat3( modelMatrix ) * normal );
`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */ `
#include <common>
${GLSL_NOISE}
uniform vec2 uSnowBand;
uniform float uSnowAmt;
uniform vec3 uSnowColor;
uniform float uRockContrast;
varying vec3 vMtnWorld;
varying vec3 vMtnNormal;
`)
        .replace('#include <map_fragment>', /* glsl */ `
// Dominant-axis projection. Hard selection rather than a blend: on a ridge that
// steep a blend double-images, and because both projections carry statistically
// identical noise the switch itself is invisible.
vec3 mAbs = abs( vMtnNormal );
vec2 mP;
if ( mAbs.y > max( mAbs.x, mAbs.z ) ) mP = vMtnWorld.xz;
else if ( mAbs.x > mAbs.z ) mP = vMtnWorld.zy;
else mP = vMtnWorld.xy;

float mA = fbm2( mP * 0.011, 3 );        // ~90 m faces and bowls
float mB = fbm2( mP * 0.052, 2 );        // ~19 m outcrops
// Bedding planes: stretched hard in the horizontal so they read as strata.
float mStrata = fbm2( vec2( ( vMtnWorld.x + vMtnWorld.z ) * 0.0032, vMtnWorld.y * 0.055 ), 2 );
float mRidge = 1.0 - abs( mB * 2.0 - 1.0 );

vec3 mTint = mix( vec3( 0.80, 0.83, 0.89 ), vec3( 1.15, 1.11, 1.02 ), mA );
mTint *= 1.0 + ( mB - 0.5 ) * 2.0 * uRockContrast;
mTint *= mix( 0.94, 1.07, mStrata );
// Gullies and crevices between outcrops. Cheap, and it is what stops a distant
// ridge from reading as painted cardboard.
mTint *= 1.0 - pow( clamp( mRidge, 0.0, 1.0 ), 6.0 ) * 0.26;
diffuseColor.rgb *= mTint * mix( vec3( 1.0 ), vec3( 0.94, 0.97, 1.04 ), 0.6 );

// The baked snow line is a smooth contour across a 220x16 mesh, i.e. a clean
// curve where there should be a ragged edge with tongues down the gullies.
if ( uSnowAmt > 0.001 ) {
  float mSnow = smoothstep( uSnowBand.x, uSnowBand.y,
    vMtnWorld.y + ( mA - 0.5 ) * 95.0 + ( mB - 0.5 ) * 30.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uSnowColor, mSnow * uSnowAmt );
}
`)
        .replace('#include <normal_fragment_maps>', /* glsl */ `
// Two forward differences of the outcrop band, so the relief is lit rather than
// merely tinted. Object-space gradient, not a screen-space one — a dFdx bump
// would swim as the camera turns.
float mE = 16.0;
vec2 mG = vec2(
  fbm2( ( mP + vec2( mE, 0.0 ) ) * 0.052, 2 ) - mB,
  fbm2( ( mP + vec2( 0.0, mE ) ) * 0.052, 2 ) - mB
) * 3.4;
vec3 mT = normalize( cross( vec3( 0.0, 1.0, 0.0 ), vMtnNormal ) + vec3( 1e-5, 0.0, 1e-5 ) );
vec3 mBt = cross( vMtnNormal, mT );
vec3 mPert = normalize( vMtnNormal + mT * mG.x + mBt * mG.y );
normal = normalize( ( viewMatrix * vec4( mPert, 0.0 ) ).xyz );
`);
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Mountains';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = RENDER_ORDER.TERRAIN;
    this.mountains = mesh;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  // -------------------------------------------------------------------------

  setCamera(camera: THREE.PerspectiveCamera): void { this.camera = camera; }

  /** Tint the whole ground — used for night / storm colour grading. */
  setMacroTint(r: number, g: number, b: number): void {
    (this.uniforms.uMacroTint.value as THREE.Vector3).set(r, g, b);
  }

  update(_ctx: FrameContext): void {
    // Placing the pivot HERE, not only in onBeforeRender, is what makes the
    // sectors cullable: three frustum-tests in `projectObject`, which runs before
    // any draw callback, so a clipmap that only re-centres from onBeforeRender is
    // being culled against last pass's position. Once per frame ahead of every
    // pass is both correct and cheaper than once per pass.
    const cam = this.camera;
    if (!cam) return;
    this.recentre(cam.position.x, cam.position.z);
    if (!this.culling) {
      this.culling = true;
      // The centre disc stays uncullable: it is the sector that owns the
      // re-centre callback, and it is in frustum from any ground-level pose.
      for (let i = 1; i < this.chunks.length; i++) this.chunks[i].frustumCulled = true;
    }
  }

  dispose(): void {
    for (const c of this.chunks) c.geometry.dispose();
    this.chunks.length = 0;
    // Disposed after the sectors: they share its vertex attributes, and three's
    // attribute cache drops a shared buffer on the first dispose that names it.
    this.gridGeometry?.dispose();
    this.gridGeometry = null;
    this.material?.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.clipmap.clear();
    this.group.clear();
    this.scene.remove(this.group);
  }
}

const _snow = new THREE.Color(0xf2f6ff);

// ---------------------------------------------------------------------------
// Clipmap partitioning
// ---------------------------------------------------------------------------

/**
 * Cut a camera-following warped grid into radial-band × angular-sector pieces,
 * each carrying a bounding sphere that describes where it actually is.
 *
 * The pieces SHARE `master`'s vertex attributes — same `BufferAttribute`
 * objects, so one VBO on the GPU — and differ only in their index buffer. That
 * makes the split free in memory and, more importantly, exactly
 * pixel-equivalent: every triangle of the original is emitted into exactly one
 * piece, with the same vertices, the same material and the same winding, so
 * drawing all the pieces draws the original surface and nothing else. Only the
 * *bounds* are new, which is the whole point — three can finally cull.
 *
 * `yMin`/`yMax` are the caller's honest bound on where the surface can end up
 * after vertex displacement, in the grid's local frame. Both users of this
 * displace Y in the vertex shader, so the geometry's own Y (0 everywhere) says
 * nothing about it.
 *
 * Shared by Terrain and Water because their grids are the same topology; keeping
 * one implementation means one place to be wrong about bounds.
 */
export function splitClipmapGrid(
  master: THREE.BufferGeometry,
  bands: readonly number[],
  sectors: readonly number[],
  yMin: number,
  yMax: number,
): THREE.BufferGeometry[] {
  const index = master.getIndex();
  const pos = master.getAttribute('position');
  if (!index || !pos || sectors.length === 0) return [master];

  const tris = Math.floor(index.count / 3);
  const nBands = sectors.length;
  const bandBase: number[] = [];
  let slots = 0;
  for (let b = 0; b < nBands; b++) { bandBase.push(slots); slots += Math.max(1, sectors[b]); }

  const src = index.array as ArrayLike<number>;
  const owner = new Int32Array(tris);
  const counts = new Int32Array(slots);
  const TAU = Math.PI * 2;

  for (let t = 0; t < tris; t++) {
    const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const r = Math.sqrt(x * x + z * z);
    let band = nBands - 1;
    for (let i = 0; i < nBands; i++) {
      if (r < (bands[i + 1] ?? Infinity)) { band = i; break; }
    }
    const s = Math.max(1, sectors[band]);
    let sec = 0;
    if (s > 1) {
      sec = Math.floor(((Math.atan2(z, x) + Math.PI) / TAU) * s);
      if (sec < 0) sec = 0; else if (sec >= s) sec = s - 1;
    }
    const id = bandBase[band] + sec;
    owner[t] = id;
    counts[id]++;
  }

  const buffers: Uint32Array[] = [];
  for (let i = 0; i < slots; i++) buffers.push(new Uint32Array(counts[i] * 3));
  const cursor = new Int32Array(slots);
  for (let t = 0; t < tris; t++) {
    const id = owner[t];
    const w = cursor[id]++ * 3;
    const dst = buffers[id];
    dst[w] = src[t * 3];
    dst[w + 1] = src[t * 3 + 1];
    dst[w + 2] = src[t * 3 + 2];
  }

  const yc = (yMin + yMax) * 0.5;
  const yh = Math.max(0.25, (yMax - yMin) * 0.5);
  const out: THREE.BufferGeometry[] = [];
  for (let id = 0; id < slots; id++) {
    if (counts[id] === 0) continue;
    const arr = buffers[id];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      const x = pos.getX(v), z = pos.getZ(v);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const g = new THREE.BufferGeometry();
    for (const name in master.attributes) g.setAttribute(name, master.attributes[name]);
    g.setIndex(new THREE.BufferAttribute(arr, 1));
    const hx = (maxX - minX) * 0.5;
    const hz = (maxZ - minZ) * 0.5;
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(minX, yMin, minZ), new THREE.Vector3(maxX, yMax, maxZ),
    );
    // Circumscribes that box, so it can only ever over-report where the sector is.
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX + maxX) * 0.5, yc, (minZ + maxZ) * 0.5),
      Math.sqrt(hx * hx + yh * yh + hz * hz) + 0.01,
    );
    out.push(g);
  }
  return out;
}
