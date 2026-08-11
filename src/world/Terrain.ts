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
    normalScale: new THREE.Vector4(1.0, 0.55, 1.0, 0.45),
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

export class Terrain implements ISubsystem {
  readonly group = new THREE.Group();
  mesh!: THREE.Mesh;
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
      uFieldXform: fu.uFieldXform,
      uSunDirection: worldFogUniforms.uSunDirection,
      uLayerAlbedo: { value: this.layers ? this.layers.albedo : null },
      uLayerNormal: { value: this.layers ? this.layers.normal : null },
      uDetailNormal: { value: this.detail },
      uTile: { value: 1 / s.tile },
      uDetailTile: { value: s.detailScale / s.tile },
      uRough: { value: s.rough.clone() },
      uBias: { value: s.bias.clone() },
      uSandBand: { value: new THREE.Vector2(s.sandTop, s.sandTop + s.sandFade) },
      uNormalStrength: { value: 1.15 },
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
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
varying vec4 vTerrData;
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
uniform vec2 uSandBand;
uniform float uNormalStrength;
uniform float uWaterLevel;
uniform float uAoStrength;
uniform vec3 uMacroTint;
uniform vec3 uSunDirection;
varying vec3 vTerrWorld;
varying vec3 vTerrNormal;
varying vec4 vTerrData;

// Weights only — the caller already has the four albedo taps, so this must never
// sample the array again. (It used to take four taps of its own purely to read
// the alpha channel, and the caller then took the same four taps for .rgb: eight
// array fetches per pixel of a surface that fills most of the screen.)
vec4 splatWeights(vec2 uv, float steep, float macro){
  float moist = vTerrData.b;
  float rockD = vTerrData.a;
  float road  = vTerrData.r;
  float alt   = vTerrWorld.y;
  float sandM = 1.0 - smoothstep( uSandBand.x, uSandBand.y, alt );

  vec4 w;
  w.x = ( 0.22 + moist * 1.15 ) * ( 1.0 - steep ) * ( 1.0 - sandM * 0.9 ) + uBias.x;
  w.y = 0.26 + ( 1.0 - moist ) * 0.80 + road * 1.35 + macro * 0.45 + uBias.y;
  w.z = steep * 2.05 + rockD * 1.15 - 0.28 + uBias.z;
  w.w = sandM * 2.25 + uBias.w;
  return max( w, vec4( 0.0 ) ) + vec4( 1e-4 );
}
`)
        // ---- albedo -------------------------------------------------------
        .replace('#include <map_fragment>', /* glsl */ `
vec3 tWN = normalize( vTerrNormal );
float steepRaw = 1.0 - clamp( tWN.y, 0.0, 1.0 );
float steep = smoothstep( 0.14, 0.52, steepRaw );
vec2 tuv = vTerrWorld.xz * uTile;
float tMacro = fbm2( vTerrWorld.xz * 0.021, 3 );
float tMacroBig = fbm2( vTerrWorld.xz * 0.0042, 2 );

// Four array taps, total. RGB is the albedo, A is that layer's height field —
// which is what lets the blend be a height blend rather than a crossfade.
vec4 a0 = texture( uLayerAlbedo, vec3( tuv, 0.0 ) );
vec4 a1 = texture( uLayerAlbedo, vec3( tuv, 1.0 ) );
vec4 a2 = texture( uLayerAlbedo, vec3( tuv, 2.0 ) );
vec4 a3 = texture( uLayerAlbedo, vec3( tuv, 3.0 ) );
vec4 tHeights = vec4( a0.a, a1.a, a2.a, a3.a );
vec4 tW = splatWeights( tuv, steep, tMacro );

// Height blend: the layer with the tallest features wins locally, which reads
// as gravel poking through grass instead of a soft airbrushed gradient.
vec4 hw = tHeights * 0.55 + tW;
float hmax = max( max( hw.x, hw.y ), max( hw.z, hw.w ) );
vec4 b = max( hw - ( hmax - 0.16 ), vec4( 0.0 ) );
b /= ( b.x + b.y + b.z + b.w );

vec3 c2 = a2.rgb;
// Cliffs get a wall projection so vertical faces don't smear. Gated on the rock
// layer actually contributing, so flat ground never pays for the extra tap.
if ( steep > 0.02 && b.z > 0.004 ) {
  vec2 wallUv = ( abs( tWN.x ) > abs( tWN.z ) )
    ? vec2( vTerrWorld.z, vTerrWorld.y ) * uTile
    : vec2( vTerrWorld.x, vTerrWorld.y ) * uTile;
  c2 = mix( c2, texture( uLayerAlbedo, vec3( wallUv, 2.0 ) ).rgb, steep );
}

vec3 tAlb = a0.rgb * b.x + a1.rgb * b.y + c2 * b.z + a3.rgb * b.w;
tAlb = srgbToLin( tAlb );
// Macro variation: two low frequencies of hue/value drift so no tile repeats.
tAlb *= mix( vec3( 0.80, 0.86, 0.78 ), vec3( 1.16, 1.10, 1.06 ), tMacroBig );
tAlb *= mix( 0.90, 1.10, tMacro );
tAlb *= uMacroTint;
// Wet band right at the shoreline.
float wet = 1.0 - smoothstep( 0.0, 1.8, vTerrWorld.y - uWaterLevel );
tAlb *= mix( 1.0, 0.52, wet );
float tAo = mix( 1.0, vTerrData.g, uAoStrength );
diffuseColor.rgb *= tAlb * tAo;
`)
        // ---- normals ------------------------------------------------------
        .replace('#include <normal_fragment_maps>', /* glsl */ `
// The height blend is sparse: after the 0.16 band clamp, usually one or two
// layers have any weight at all. Skipping the zero-weight normal taps is worth
// real milliseconds on a surface this size, and neighbouring pixels take the
// same branch, so the divergence cost is nil.
vec3 tN = vec3( 0.0, 0.0, 1.0 ) * 0.0;
if ( b.x > 0.004 ) tN += ( texture( uLayerNormal, vec3( tuv, 0.0 ) ).xyz * 2.0 - 1.0 ) * b.x;
if ( b.y > 0.004 ) tN += ( texture( uLayerNormal, vec3( tuv, 1.0 ) ).xyz * 2.0 - 1.0 ) * b.y;
if ( b.z > 0.004 ) tN += ( texture( uLayerNormal, vec3( tuv, 2.0 ) ).xyz * 2.0 - 1.0 ) * b.z;
if ( b.w > 0.004 ) tN += ( texture( uLayerNormal, vec3( tuv, 3.0 ) ).xyz * 2.0 - 1.0 ) * b.w;
vec3 dN = texture( uDetailNormal, vTerrWorld.xz * uDetailTile ).xyz * 2.0 - 1.0;
tN.xy += dN.xy * 0.55;

vec3 wT = normalize( cross( vec3( 0.0, 1.0, 0.0 ), tWN ) + vec3( 1e-5, 0.0, 1e-5 ) );
vec3 wB = cross( tWN, wT );
float ns = uNormalStrength * mix( 1.0, 0.35, wet );
vec3 pert = normalize( tWN + wT * tN.x * ns + wB * tN.y * ns );
normal = normalize( ( viewMatrix * vec4( pert, 0.0 ) ).xyz );
`)
        // ---- roughness ----------------------------------------------------
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
float roughnessFactor = dot( uRough, b );
roughnessFactor *= mix( 1.0, 0.34, wet );
roughnessFactor = clamp( roughnessFactor + ( tMacro - 0.5 ) * 0.10, 0.05, 1.0 );
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

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'TerrainGrid';
    mesh.frustumCulled = false;
    mesh.castShadow = false;      // the field-march handles ground self-shadow
    mesh.receiveShadow = true;
    mesh.renderOrder = RENDER_ORDER.TERRAIN;
    mesh.matrixAutoUpdate = true;

    // Self-position: the terrain must be centred on whatever perspective camera
    // is drawing it (main view, or a mirrored water-reflection camera).
    mesh.onBeforeRender = (_r, _s, cam) => {
      const pc = cam as THREE.PerspectiveCamera;
      if (!pc.isPerspectiveCamera) return;
      this.camera = pc;
      mesh.position.set(pc.position.x, 0, pc.position.z);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
    };

    this.mesh = mesh;
    this.group.add(mesh);
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
    // A touch of altitude-driven desaturation + a rim light term keeps the
    // distant ridges reading as *distance* rather than as flat cardboard.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>', /* glsl */ `
diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.94, 0.97, 1.04 ), 0.6 );
`,
      );
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
    // Positioning happens in onBeforeRender so the mesh is also correct for the
    // water reflection pass. Nothing to do per frame.
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.scene.remove(this.group);
  }
}

const _snow = new THREE.Color(0xf2f6ff);
