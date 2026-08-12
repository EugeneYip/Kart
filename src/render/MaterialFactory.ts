/**
 * ============================================================================
 *  FOXY KART — MATERIAL FACTORY
 * ============================================================================
 *  Turns a `PbrSet` from TextureFactory into a shader-injected
 *  MeshStandardMaterial. Three things here matter more than anything else in
 *  the renderer:
 *
 *  1. DETAIL-NORMAL BLENDING (`addDetailNormal`)
 *     A 4–8× tiled micro normal composited on top of the macro normal with
 *     *Reoriented Normal Mapping* (Barré-Brisebois & Hill, 2012). Naive
 *     addition flattens the macro shape and produces the "wet plastic" look;
 *     RNM rotates the detail normal into the macro normal's frame, so both
 *     scales survive. This single function is the difference between
 *     "procedural noise" and "a game surface".
 *
 *  2. TRIPLANAR MAPPING (`triplanarMaterial`)
 *     World-space projection on all three axes with swizzled normal blending,
 *     so terrain and rocks never show stretched UVs on a slope.
 *
 *  3. Packed ORM sampling — TextureFactory hands the same RGBA texture back
 *     for roughness/AO/metalness (glTF channel packing), which three.js reads
 *     from .g/.r/.b for free.
 *
 *  All injection is done with `onBeforeCompile` + a stable `customProgramCacheKey`
 *  so three.js doesn't recompile every frame or collapse two variants into one.
 * ============================================================================
 */

import * as THREE from 'three';
import { LAYERS } from '@/core/Config';
import type { PbrSet } from './TextureFactory';
import { detailNormal as makeDetailNormal, setAnisotropy } from './TextureFactory';

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/**
 * Reoriented Normal Mapping. `n1` is the macro normal, `n2` the detail normal,
 * both in tangent space, both already decoded to [-1,1].
 *
 * The trick: build the quaternion-free rotation that takes +Z to n1 and apply
 * it to n2. `UDN` (the cheaper `normalize(vec3(n1.xy + n2.xy, n1.z))`) is also
 * provided because it's a better fit for very high-frequency detail where the
 * extra fidelity of RNM isn't visible.
 */
const NORMAL_BLEND_GLSL = /* glsl */ `
vec3 apxBlendRNM(vec3 n1, vec3 n2) {
  vec3 t = n1 + vec3(0.0, 0.0, 1.0);
  vec3 u = n2 * vec3(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}

vec3 apxBlendUDN(vec3 n1, vec3 n2) {
  return normalize(vec3(n1.xy + n2.xy, n1.z));
}
`;

/** The replacement for three's `normal_fragment_maps` when detail is enabled. */
const DETAIL_NORMAL_GLSL = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE

  vec3 apxMacroN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  apxMacroN.xy *= normalScale;
  apxMacroN = normalize( apxMacroN );

  vec3 apxDetailN = texture2D( apxDetailMap, vNormalMapUv * apxDetailParams.x ).xyz * 2.0 - 1.0;
  apxDetailN.xy *= apxDetailParams.y;
  apxDetailN = normalize( apxDetailN );

  #ifdef APX_DETAIL_UDN
    vec3 apxN = apxBlendUDN( apxMacroN, apxDetailN );
  #else
    vec3 apxN = apxBlendRNM( apxMacroN, apxDetailN );
  #endif

  normal = normalize( tbn * apxN );

#elif defined( USE_NORMALMAP_OBJECTSPACE )

  normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );

#endif
`;

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

const created = new Set<THREE.Material>();
let sharedDetail: THREE.Texture | null = null;

/** The default micro-normal every surface gets. Generated once, shared. */
export function getSharedDetailNormal(): THREE.Texture {
  if (!sharedDetail) sharedDetail = makeDetailNormal(512);
  return sharedDetail;
}

function track<T extends THREE.Material>(m: T): T {
  created.add(m);
  return m;
}

function toVec2(v: number | THREE.Vector2 | undefined, fallback: number): THREE.Vector2 {
  if (v === undefined) return new THREE.Vector2(fallback, fallback);
  if (typeof v === 'number') return new THREE.Vector2(v, v);
  return v.clone();
}

/**
 * Point every map in a PbrSet at the same tiling. three.js only honours the
 * `.repeat` of `map` for `vMapUv`, but each of the other maps has its own UV
 * transform slot, so they all have to agree — a mismatch is a classic
 * "why is my normal map sliding" bug.
 */
function applyRepeat(set: PbrSet, repeat: THREE.Vector2, aniso?: number): void {
  const maps: Array<THREE.Texture | undefined> = [
    set.map, set.normalMap, set.roughnessMap, set.aoMap, set.metalnessMap,
  ];
  for (const t of maps) {
    if (!t) continue;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.copy(repeat);
    if (aniso !== undefined) setAnisotropy(t, aniso);
    t.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Detail normal injection
// ---------------------------------------------------------------------------

interface DetailState {
  map: { value: THREE.Texture };
  params: { value: THREE.Vector2 };
  mode: 'rnm' | 'udn';
}

const detailStates = new WeakMap<THREE.Material, DetailState>();

/**
 * Composite a fine, tiled normal map on top of `material`'s existing normal
 * map using Reoriented Normal Mapping (or UDN).
 *
 * @param material  Any material with a tangent-space `normalMap`.
 * @param detailTex The micro normal map. Must be RepeatWrapping.
 * @param scale     UV multiplier for the detail map, relative to the normal
 *                  map's UVs. 4–8 is the sweet spot.
 * @param strength  Detail XY gain. 0.3–0.8 for most surfaces.
 * @param mode      'rnm' (default, correct) or 'udn' (cheaper).
 */
export function addDetailNormal(
  material: THREE.Material,
  detailTex: THREE.Texture,
  scale = 5,
  strength = 0.55,
  mode: 'rnm' | 'udn' = 'rnm',
): void {
  const existing = detailStates.get(material);
  if (existing) {
    existing.map.value = detailTex;
    existing.params.value.set(scale, strength);
    if (existing.mode !== mode) {
      existing.mode = mode;
      material.needsUpdate = true;
    }
    return;
  }

  detailTex.wrapS = THREE.RepeatWrapping;
  detailTex.wrapT = THREE.RepeatWrapping;

  const state: DetailState = {
    map: { value: detailTex },
    params: { value: new THREE.Vector2(scale, strength) },
    mode,
  };
  detailStates.set(material, state);

  const prevHook = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    prevHook?.call(material, shader, renderer);

    shader.uniforms.apxDetailMap = state.map;
    shader.uniforms.apxDetailParams = state.params;

    let fs = shader.fragmentShader;
    // Declare our uniforms + helpers right after the standard prologue.
    fs = fs.replace(
      '#include <normal_pars_fragment>',
      `#include <normal_pars_fragment>
uniform sampler2D apxDetailMap;
uniform vec2 apxDetailParams;
${state.mode === 'udn' ? '#define APX_DETAIL_UDN 1' : ''}
${NORMAL_BLEND_GLSL}`,
    );
    // Swap the normal assembly for the blended version.
    fs = fs.replace('#include <normal_fragment_maps>', DETAIL_NORMAL_GLSL);
    shader.fragmentShader = fs;
  };

  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () =>
    `${prevKey ? prevKey() : ''}|apxDetail:${state.mode}`;

  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Shading-normal repair
// ---------------------------------------------------------------------------

/**
 * Negate the shading normal of a material whose GEOMETRY has its winding and its
 * vertex normals disagreeing.
 *
 * three has exactly one invariant here: `dot(faceNormal, vertexNormal) > 0`.
 * `FLIP_SIDED` (`side: BackSide`) negates the normal on the assumption that it
 * held, and `DOUBLE_SIDED` multiplies by `faceDirection` on the same assumption.
 * Break it and BOTH mechanisms resolve the wrong way: the surface you are
 * looking at is shaded with a normal pointing away from you, `dotNL` clamps to
 * zero for every light on your side, and only ambient survives. That is a black
 * surface, and no `side` value can rescue it — the normal itself has to move.
 *
 * The injection goes in right after `<defaultnormal_vertex>` (which is where
 * `transformedNormal` is established, and where `FLIP_SIDED` is applied) and
 * before `<normal_vertex>` (which publishes `vNormal`). It is fragment-shader
 * agnostic, so it composes with {@link addDetailNormal} and with the road
 * shader; and if three ever renames the chunk the replace is a silent no-op
 * rather than a broken program.
 *
 * ⚠️ THIS IS A REPAIR, NOT A FEATURE. It exists because
 * `.probe-tmp/road-black-audit.ts` measured the barrier and tunnel strips built
 * by `TrackBuilder` as 90–100 % inconsistent. When that geometry is fixed at
 * source, every call to this function must be removed in the same commit — the
 * audit probe asserts the pairing in both directions and will fail loudly if
 * one is fixed without the other.
 */
export function flipVertexNormals(material: THREE.Material): void {
  if (material.userData.apxFlipNormals === true) return;
  material.userData.apxFlipNormals = true;

  const prevHook = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prevHook?.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <defaultnormal_vertex>',
      '#include <defaultnormal_vertex>\ntransformedNormal = - transformedNormal;',
    );
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|apxFlipN`;
  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// standardFromPbr
// ---------------------------------------------------------------------------

export interface StandardOpts {
  /** Tiling. A number means uniform; use a Vector2 for anisotropic tiling. */
  repeat?: number | THREE.Vector2;
  /** Multiplied into the albedo map. Leave white unless tinting. */
  color?: THREE.ColorRepresentation;
  /** Scalar multiplier on the roughness map. */
  roughness?: number;
  /** Scalar multiplier on the metalness map (or a constant if no map). */
  metalness?: number;
  /** Override the PbrSet's suggested normal strength. */
  normalScale?: number;
  /** 0 disables AO, 1 is the baked amount, >1 exaggerates. */
  aoIntensity?: number;
  /** Micro-normal detail. `true` uses the shared detail map at 5× / 0.55. */
  detail?: boolean | { tex?: THREE.Texture; scale?: number; strength?: number; mode?: 'rnm' | 'udn' };
  envMapIntensity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  /** Push the surface towards/away from the camera in depth — decals. */
  polygonOffsetUnits?: number;
  anisotropy?: number;
  dithering?: boolean;
  name?: string;
}

/**
 * The workhorse. Wires a PbrSet into a MeshStandardMaterial, honouring the
 * packed ORM layout, and blends in the micro detail normal.
 */
export function standardFromPbr(set: PbrSet, opts: StandardOpts = {}): THREE.MeshStandardMaterial {
  const repeat = toVec2(opts.repeat, 1);
  applyRepeat(set, repeat, opts.anisotropy);

  const mat = new THREE.MeshStandardMaterial({
    name: opts.name ?? 'apx-standard',
    color: opts.color ?? 0xffffff,
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    aoMap: set.aoMap ?? null,
    metalnessMap: set.metalnessMap ?? null,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? (set.metalnessMap ? 1 : 0),
    aoMapIntensity: opts.aoIntensity ?? 1,
    envMapIntensity: opts.envMapIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    vertexColors: opts.vertexColors ?? false,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    dithering: opts.dithering ?? true,
  });

  const ns = opts.normalScale ?? set.normalScale ?? 1;
  mat.normalScale.set(ns, ns);

  if (opts.depthWrite !== undefined) mat.depthWrite = opts.depthWrite;
  if (opts.polygonOffsetUnits !== undefined) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = opts.polygonOffsetUnits;
  }

  if (opts.detail !== false) {
    const d = typeof opts.detail === 'object' ? opts.detail : {};
    const tex = d.tex ?? getSharedDetailNormal();
    // Detail UVs are relative to the macro UVs, so a heavily-tiled surface
    // needs a *smaller* multiplier or the micro noise turns into aliasing.
    const autoScale = Math.max(1.5, 6 / Math.max(1, Math.cbrt(repeat.x)));
    addDetailNormal(mat, tex, d.scale ?? autoScale, d.strength ?? 0.5, d.mode ?? 'rnm');
  }

  return track(mat);
}

// ---------------------------------------------------------------------------
// Triplanar
// ---------------------------------------------------------------------------

const TRIPLANAR_VERT_HEAD = /* glsl */ `
varying vec3 apxWorldPos;
varying vec3 apxWorldNrm;
`;

const TRIPLANAR_VERT_BODY = /* glsl */ `
apxWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
apxWorldNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

const TRIPLANAR_FRAG_HEAD = /* glsl */ `
varying vec3 apxWorldPos;
varying vec3 apxWorldNrm;
uniform vec3 apxTriParams;   // x = 1/scale, y = blend sharpness, z = detail scale

vec3 apxTriWeights() {
  vec3 w = pow( abs( apxWorldNrm ), vec3( apxTriParams.y ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}
`;

/** Albedo: three projections, weighted by the world normal. */
const TRIPLANAR_MAP_GLSL = /* glsl */ `
#ifdef USE_MAP
  {
    vec3 apxW = apxTriWeights();
    vec3 apxP = apxWorldPos * apxTriParams.x;
    vec4 apxTx = texture2D( map, apxP.zy ) * apxW.x
               + texture2D( map, apxP.xz ) * apxW.y
               + texture2D( map, apxP.xy ) * apxW.z;
    diffuseColor *= apxTx;
  }
#endif
`;

const TRIPLANAR_ORM_GLSL = /* glsl */ `
{
  vec3 apxW = apxTriWeights();
  vec3 apxP = apxWorldPos * apxTriParams.x;
  #ifdef USE_ROUGHNESSMAP
    vec4 apxRm = texture2D( roughnessMap, apxP.zy ) * apxW.x
               + texture2D( roughnessMap, apxP.xz ) * apxW.y
               + texture2D( roughnessMap, apxP.xy ) * apxW.z;
    roughnessFactor *= apxRm.g;
  #endif
}
`;

const TRIPLANAR_METAL_GLSL = /* glsl */ `
{
  vec3 apxW = apxTriWeights();
  vec3 apxP = apxWorldPos * apxTriParams.x;
  #ifdef USE_METALNESSMAP
    vec4 apxMm = texture2D( metalnessMap, apxP.zy ) * apxW.x
               + texture2D( metalnessMap, apxP.xz ) * apxW.y
               + texture2D( metalnessMap, apxP.xy ) * apxW.z;
    metalnessFactor *= apxMm.b;
  #endif
}
`;

/**
 * Triplanar normals. Each plane's tangent-space normal is swizzled into world
 * space (the "whiteout" variant: XY perturbs the two in-plane axes, Z keeps the
 * face direction), then the three are summed and normalised. This is what stops
 * a triplanar cliff from looking flat-shaded.
 */
const TRIPLANAR_NORMAL_GLSL = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
  {
    vec3 apxW = apxTriWeights();
    vec3 apxP = apxWorldPos * apxTriParams.x;
    vec3 apxAx = apxWorldNrm;

    vec3 apxNx = texture2D( normalMap, apxP.zy ).xyz * 2.0 - 1.0;
    vec3 apxNy = texture2D( normalMap, apxP.xz ).xyz * 2.0 - 1.0;
    vec3 apxNz = texture2D( normalMap, apxP.xy ).xyz * 2.0 - 1.0;

    apxNx.xy *= normalScale;
    apxNy.xy *= normalScale;
    apxNz.xy *= normalScale;

    #ifdef APX_TRI_DETAIL
      vec3 apxDx = texture2D( apxDetailMap, apxP.zy * apxTriParams.z ).xyz * 2.0 - 1.0;
      vec3 apxDy = texture2D( apxDetailMap, apxP.xz * apxTriParams.z ).xyz * 2.0 - 1.0;
      vec3 apxDz = texture2D( apxDetailMap, apxP.xy * apxTriParams.z ).xyz * 2.0 - 1.0;
      apxDx.xy *= apxDetailParams.y;
      apxDy.xy *= apxDetailParams.y;
      apxDz.xy *= apxDetailParams.y;
      apxNx = apxBlendRNM( normalize( apxNx ), normalize( apxDx ) );
      apxNy = apxBlendRNM( normalize( apxNy ), normalize( apxDy ) );
      apxNz = apxBlendRNM( normalize( apxNz ), normalize( apxDz ) );
    #endif

    // Whiteout blend: perturb the in-plane axes, keep the surface direction.
    vec3 apxWx = vec3( apxNx.z * sign( apxAx.x ), apxNx.y, apxNx.x );
    vec3 apxWy = vec3( apxNy.x, apxNy.z * sign( apxAx.y ), apxNy.y );
    vec3 apxWz = vec3( apxNz.x, apxNz.y, apxNz.z * sign( apxAx.z ) );

    vec3 apxWorld = normalize( apxWx * apxW.x + apxWy * apxW.y + apxWz * apxW.z );
    normal = normalize( ( viewMatrix * vec4( apxWorld, 0.0 ) ).xyz );
    #ifdef DOUBLE_SIDED
      normal = normal * faceDirection;
    #endif
  }
#endif
`;

export interface TriplanarOpts {
  /** Blend exponent. 4–8; higher is a crisper transition between planes. */
  sharpness?: number;
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  aoIntensity?: number;
  envMapIntensity?: number;
  vertexColors?: boolean;
  side?: THREE.Side;
  /** Add the micro detail normal on all three planes. */
  detail?: boolean | { tex?: THREE.Texture; scale?: number; strength?: number };
  name?: string;
  anisotropy?: number;
}

/**
 * World-space triplanar material for terrain, cliffs and rocks. `scale` is the
 * size of one texture tile in metres — 6 means the texture repeats every 6 m,
 * no matter how the mesh is UV'd (it isn't UV'd at all).
 */
export function triplanarMaterial(
  set: PbrSet,
  scale = 6,
  opts: TriplanarOpts = {},
): THREE.MeshStandardMaterial {
  applyRepeat(set, new THREE.Vector2(1, 1), opts.anisotropy);

  const mat = new THREE.MeshStandardMaterial({
    name: opts.name ?? 'apx-triplanar',
    color: opts.color ?? 0xffffff,
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    metalnessMap: set.metalnessMap ?? null,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? (set.metalnessMap ? 1 : 0),
    envMapIntensity: opts.envMapIntensity ?? 1,
    vertexColors: opts.vertexColors ?? false,
    side: opts.side ?? THREE.FrontSide,
    dithering: true,
  });
  // AO would need the shared UV set; triplanar has none, so the cavity darkening
  // is folded into the albedo instead (TextureFactory already bakes it in).
  mat.aoMap = null;

  const ns = opts.normalScale ?? set.normalScale ?? 1;
  mat.normalScale.set(ns, ns);

  const useDetail = opts.detail !== false;
  const detailCfg = typeof opts.detail === 'object' ? opts.detail : {};
  const detailTex = useDetail ? (detailCfg.tex ?? getSharedDetailNormal()) : null;

  const params = {
    value: new THREE.Vector3(
      1 / Math.max(0.001, scale),
      opts.sharpness ?? 5,
      detailCfg.scale ?? 5,
    ),
  };
  const detailMapU = { value: detailTex };
  const detailParamsU = { value: new THREE.Vector2(detailCfg.scale ?? 5, detailCfg.strength ?? 0.45) };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.apxTriParams = params;
    if (detailTex) {
      shader.uniforms.apxDetailMap = detailMapU;
      shader.uniforms.apxDetailParams = detailParamsU;
    }

    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${TRIPLANAR_VERT_HEAD}`);
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>\n${TRIPLANAR_VERT_BODY}`,
    );
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>
${TRIPLANAR_FRAG_HEAD}
${NORMAL_BLEND_GLSL}
${detailTex ? '#define APX_TRI_DETAIL 1\nuniform sampler2D apxDetailMap;\nuniform vec2 apxDetailParams;' : ''}`,
    );
    // Replace the UV-based lookups with the world-space projections.
    fs = fs.replace('#include <map_fragment>', TRIPLANAR_MAP_GLSL);
    fs = fs.replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;\n${TRIPLANAR_ORM_GLSL}`);
    fs = fs.replace('#include <metalnessmap_fragment>', `float metalnessFactor = metalness;\n${TRIPLANAR_METAL_GLSL}`);
    fs = fs.replace('#include <normal_fragment_maps>', TRIPLANAR_NORMAL_GLSL);
    shader.fragmentShader = fs;
  };

  mat.customProgramCacheKey = () => `apxTriplanar:${detailTex ? 'd' : 'n'}`;
  mat.needsUpdate = true;

  return track(mat);
}

// ---------------------------------------------------------------------------
// Emissive
// ---------------------------------------------------------------------------

export interface GlowOpts {
  /** Base (non-emissive) colour. Defaults to black so the glow reads pure. */
  base?: THREE.ColorRepresentation;
  transparent?: boolean;
  opacity?: number;
  /** Additive blending — right for flames and sparks, wrong for solid neon. */
  additive?: boolean;
  toneMapped?: boolean;
  name?: string;
}

/**
 * A bloom-ready emissive material. `intensity` above 1 is expected: the post
 * chain thresholds at 0.85 in HDR, so 2–6 is a strong glow.
 *
 * The material records `LAYERS.BLOOM` in `userData.layer`; call
 * {@link markBloom} on the mesh (layers live on Object3D, not Material) — or
 * just pass the mesh straight to `markBloom` after assigning this material.
 */
export function emissiveGlow(
  color: THREE.ColorRepresentation,
  intensity = 2.5,
  opts: GlowOpts = {},
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: opts.name ?? 'apx-glow',
    color: opts.base ?? 0x000000,
    emissive: new THREE.Color(color),
    emissiveIntensity: Math.max(0, intensity),
    roughness: 0.45,
    metalness: 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.transparent ? false : true,
    toneMapped: opts.toneMapped ?? true,
  });
  if (opts.additive) {
    mat.blending = THREE.AdditiveBlending;
    mat.transparent = true;
    mat.depthWrite = false;
  }
  mat.userData.layer = LAYERS.BLOOM;
  return track(mat);
}

/** Enable the BLOOM layer on an object (and its children). */
export function markBloom(object: THREE.Object3D, recursive = true): void {
  object.layers.enable(LAYERS.BLOOM);
  if (recursive) {
    for (const child of object.children) markBloom(child, true);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Release every material this factory made. Textures belong to TextureFactory. */
export function disposeMaterials(): void {
  for (const m of created) m.dispose();
  created.clear();
  sharedDetail = null;
}

export const materialFactory = {
  standardFromPbr,
  triplanarMaterial,
  addDetailNormal,
  flipVertexNormals,
  emissiveGlow,
  markBloom,
  getSharedDetailNormal,
  disposeMaterials,
};

export default materialFactory;
