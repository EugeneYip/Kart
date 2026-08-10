/**
 * ============================================================================
 *  RoadMaterial — every material the circuit is built from
 * ============================================================================
 *
 *  The road is the single most-looked-at surface in the game, so it gets a
 *  custom shader on top of `standardFromPbr`:
 *
 *   * **World-scale tiling.** UV0 is (lateral / tile, arcLength / tile) so the
 *     aggregate is the same physical size on a 15 m alley and a 25 m boulevard.
 *
 *   * **Track-space second UV set.** UV1 is (u across the road 0..1, v along
 *     the lap 0..1). Everything that must not tile is addressed with it:
 *     the decal atlas (grid, arrows, logos, skid marks) and a macro
 *     discolouration field that breaks the repeat.
 *
 *   * **Baked racing line.** The builder writes a per-vertex `apxMask` where
 *     x = tyre polish along the ideal line, y = standing water, z = kerb/paint
 *     mix. Polish darkens the albedo *and* drops roughness, which is what
 *     actually reads as "rubber has been laid down here" — a texture alone
 *     never does.
 *
 *   * **Vertex-colour AO.** Multiplied into albedo: dark in the kerb valleys,
 *     under guardrails, along the road edge where dirt collects.
 *
 *  Nothing here downloads anything: every texture comes from
 *  `@/render/TextureFactory`, or is drawn on a canvas in this file.
 * ============================================================================
 */

import * as THREE from 'three';
import { SurfaceType } from '@/core/Types';
import type { QualitySettings } from '@/core/Types';
import * as TX from '@/render/TextureFactory';
import type { PbrSet } from '@/render/TextureFactory';
import * as MX from '@/render/MaterialFactory';
import type { RoadStyle, TrackDef } from './TrackDefs';
import type { WallStyle } from './TrackSpline';

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

const ROAD_PARS = /* glsl */ `
attribute vec2 apxUv2;
attribute vec3 apxMask;
varying vec2 vApxUv2;
varying vec3 vApxMask;
`;

const ROAD_VERT = /* glsl */ `
vApxUv2 = apxUv2;
vApxMask = apxMask;
`;

const ROAD_FRAG_PARS = /* glsl */ `
varying vec2 vApxUv2;
varying vec3 vApxMask;
uniform sampler2D apxDecalMap;
uniform sampler2D apxMacroMap;
/** x: decal opacity  y: macro contrast  z: polish strength  w: wet strength */
uniform vec4 apxRoadParams;
uniform vec3 apxPolishTint;
`;

/**
 * Runs right after three's albedo/roughness are established.
 *  - macro field kills the tiling repeat
 *  - baked racing line darkens + polishes
 *  - the track-space decal atlas paints over the top
 */
const ROAD_FRAG = /* glsl */ `
{
  // --- macro discolouration (track space, very low frequency) --------------
  vec3 macro = texture2D(apxMacroMap, vApxUv2 * vec2(1.0, 9.0)).rgb;
  float md = (macro.r - 0.5) * apxRoadParams.y;
  diffuseColor.rgb *= (1.0 + md);
  roughnessFactor *= (1.0 - md * 0.35);

  // --- tyre-polished racing line ------------------------------------------
  float polish = clamp(vApxMask.x, 0.0, 1.0) * apxRoadParams.z;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * apxPolishTint, polish);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.52, polish);

  // --- standing water ------------------------------------------------------
  float wet = clamp(vApxMask.y, 0.0, 1.0) * apxRoadParams.w;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42, wet);
  roughnessFactor = mix(roughnessFactor, 0.045, wet);

  // --- track-space decals (paint, arrows, logos, skid marks) ---------------
  vec4 dc = texture2D(apxDecalMap, vApxUv2);
  float da = dc.a * apxRoadParams.x;
  diffuseColor.rgb = mix(diffuseColor.rgb, dc.rgb, da);
  // fresh paint is smoother than aggregate, skid rubber is rougher; the
  // decal's green channel biases between the two.
  roughnessFactor = mix(roughnessFactor, mix(0.78, 0.34, dc.g), da * 0.85);
}
`;

interface RoadUniforms {
  apxDecalMap: { value: THREE.Texture };
  apxMacroMap: { value: THREE.Texture };
  apxRoadParams: { value: THREE.Vector4 };
  apxPolishTint: { value: THREE.Color };
}

// ---------------------------------------------------------------------------
// Local canvas helpers (things TextureFactory does not ship)
// ---------------------------------------------------------------------------

/**
 * Painted rumble strip. The kerb's *shape* is real geometry (chamfers plus an
 * analytic rumble sawtooth, see TrackBuilder.CROSS); this texture only carries
 * the paint, at a fixed world scale — V maps to arcLength / (2 * stripe), so
 * one texture height is exactly two stripes and the edges stay razor sharp at
 * every ring spacing. U runs across the kerb, inner edge to outer.
 */
function kerbAlbedo(size: number, colA: number, colB: number): THREE.CanvasTexture {
  const ca = new THREE.Color(colA);
  const cb = new THREE.Color(colB);
  const css = (c: THREE.Color, k = 1) =>
    `rgb(${Math.round(clamp255(c.r * 255 * k))},${Math.round(clamp255(c.g * 255 * k))},${Math.round(clamp255(c.b * 255 * k))})`;

  return TX.canvasTexture(size, size, (ctx, w, h) => {
    // two stripes stacked along V
    ctx.fillStyle = css(ca);
    ctx.fillRect(0, 0, w, h * 0.5);
    ctx.fillStyle = css(cb);
    ctx.fillRect(0, h * 0.5, w, h * 0.5);

    // paint has a soft, slightly bled join
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = css(ca, 0.8);
    ctx.fillRect(0, h * 0.5 - 2, w, 4);
    ctx.globalAlpha = 1;

    // cement showing through where the paint has worn
    for (let i = 0; i < 2200; i++) {
      const v = 176 + Math.random() * 62;
      ctx.fillStyle = `rgba(${v | 0},${(v - 3) | 0},${(v - 12) | 0},${0.05 + Math.random() * 0.4})`;
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, 1 + Math.random() * 7, 0, Math.PI * 2);
      ctx.fill();
    }
    // aggregate speckle
    for (let i = 0; i < 7000; i++) {
      const v = 120 + Math.random() * 90;
      ctx.fillStyle = `rgba(${v | 0},${v | 0},${(v - 8) | 0},${0.08 + Math.random() * 0.18})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    // black rubber scuffs from a thousand kerb-hops, running across the kerb
    ctx.strokeStyle = 'rgba(34,31,30,0.3)';
    for (let i = 0; i < 46; i++) {
      ctx.lineWidth = 1 + Math.random() * 5;
      const y = Math.random() * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 26, w * 0.7, y + (Math.random() - 0.5) * 26, w, y + (Math.random() - 0.5) * 14);
      ctx.stroke();
    }
    // dirt collecting on the outer lip (U -> 1)
    const g = ctx.createLinearGradient(w * 0.72, 0, w, 0);
    g.addColorStop(0, 'rgba(74,62,44,0)');
    g.addColorStop(1, 'rgba(74,62,44,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(w * 0.72, 0, w * 0.28, h);
    // and a shadow line right on the inner edge
    const g2 = ctx.createLinearGradient(0, 0, w * 0.1, 0);
    g2.addColorStop(0, 'rgba(28,26,24,0.42)');
    g2.addColorStop(1, 'rgba(28,26,24,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w * 0.1, h);
  }, { srgb: true, repeat: 1 });
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * TextureFactory caches and shares its PbrSets, and `standardFromPbr` writes
 * `repeat` straight onto the textures — so two materials asking for the same
 * recipe at different tilings would fight over one Texture object. Clone the
 * views (three shares `Texture.source`, so the GPU upload is still one copy)
 * and hand each material its own UV transform.
 */
function cloneSet(set: PbrSet, sink: THREE.Texture[]): PbrSet {
  const c = (t: THREE.Texture | undefined): THREE.Texture | undefined => {
    if (!t) return undefined;
    const k = t.clone();
    k.needsUpdate = true;
    sink.push(k);
    return k;
  };
  return {
    map: c(set.map)!,
    normalMap: c(set.normalMap)!,
    roughnessMap: c(set.roughnessMap)!,
    aoMap: c(set.aoMap),
    metalnessMap: c(set.metalnessMap),
    normalScale: set.normalScale,
    tileMetres: set.tileMetres,
  };
}

/** Very low frequency albedo/roughness variation for the road, track space. */
function macroField(size: number): THREE.DataTexture {
  const f = TX.fbm2D(size, size, { octaves: 5, frequency: 3, gain: 0.58, seed: 4127, warp: 0.22 });
  // Bias so patch repairs read as discrete slabs rather than smooth noise.
  const g = TX.fbm2D(size, size, { octaves: 2, frequency: 7, gain: 0.5, seed: 991 });
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const slab = g[i] > 0.62 ? 0.16 : g[i] < 0.36 ? -0.1 : 0;
    out[i] = Math.max(0, Math.min(1, f[i] * 0.8 + 0.1 + slab));
  }
  return TX.floatToTexture(out, size, size);
}

/** Chain-link fence with real alpha. */
function chainLink(size: number): THREE.CanvasTexture {
  const tex = TX.canvasTexture(size, size, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cell = w / 12;
    ctx.strokeStyle = 'rgba(196,204,214,0.95)';
    ctx.lineWidth = Math.max(1.5, w / 340);
    for (let i = -12; i < 24; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell + h, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(i * cell, h);
      ctx.lineTo(i * cell + h, 0);
      ctx.stroke();
    }
  }, { srgb: true, repeat: 1 });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Public set
// ---------------------------------------------------------------------------

export interface RoadMaterials {
  /** Main asphalt ribbon. Custom shader, vertex colours + apxMask + apxUv2. */
  road: THREE.MeshStandardMaterial;
  /** 3D kerb / rumble strip. Vertex colour drives the stripes. */
  kerb: THREE.MeshStandardMaterial;
  /** Off-road shoulder, keyed by SurfaceType. */
  shoulder: Map<SurfaceType, THREE.MeshStandardMaterial>;
  /** Guardrail / barrier / rock face, keyed by wall style. */
  wall: Map<WallStyle, THREE.Material>;
  /** Metal for instanced guardrail posts + swept rail. */
  rail: THREE.MeshStandardMaterial;
  /** Emissive energy rail (anti-gravity). */
  energy: THREE.MeshStandardMaterial;
  /** Tunnel arch interior. */
  tunnel: THREE.MeshStandardMaterial;
  /** Underside of bridges / elevated decks. */
  deck: THREE.MeshStandardMaterial;
  /** Boost pad. */
  boost: THREE.MeshStandardMaterial;

  setDecalTexture(tex: THREE.Texture): void;
  /** Live tweak from the dev harness. */
  setRoadParams(p: { decal?: number; macro?: number; polish?: number; wet?: number }): void;
  dispose(): void;
}

/** Attach the custom road shader to an already-built standard material. */
function makeRoadShader(
  mat: THREE.MeshStandardMaterial,
  decal: THREE.Texture,
  macro: THREE.Texture,
  style: RoadStyle,
): RoadUniforms {
  const uni: RoadUniforms = {
    apxDecalMap: { value: decal },
    apxMacroMap: { value: macro },
    apxRoadParams: { value: new THREE.Vector4(1, 0.14, style.racingLine, 1) },
    apxPolishTint: { value: new THREE.Color(0.62, 0.6, 0.6) },
  };

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.apxDecalMap = uni.apxDecalMap;
    shader.uniforms.apxMacroMap = uni.apxMacroMap;
    shader.uniforms.apxRoadParams = uni.apxRoadParams;
    shader.uniforms.apxPolishTint = uni.apxPolishTint;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_PARS}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${ROAD_VERT}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`)
      // roughnessFactor exists from here on, and diffuseColor already has map applied
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROAD_FRAG}`);
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|apxRoad`;
  mat.needsUpdate = true;
  return uni;
}

/** Build every material a circuit needs. Textures are shared/cached. */
export function createRoadMaterials(def: TrackDef, quality: QualitySettings): RoadMaterials {
  // Track loads before RenderPipeline in Game.init, so make sure the shared
  // texture factory is sized for this tier before we ask it for anything.
  TX.configure({
    anisotropy: quality.anisotropy,
    maxSize: quality.tier === 'low' ? 1024 : 2048,
  });

  const big = quality.tier === 'low' ? 1024 : 2048;
  const mid = quality.tier === 'low' ? 512 : 1024;
  const style = def.road;
  const owned: THREE.Material[] = [];
  const ownedTex: THREE.Texture[] = [];

  // ---- road ---------------------------------------------------------------
  const asphalt = cloneSet(TX.makeAsphalt(big, style.asphalt), ownedTex);
  const macro = macroField(256);
  macro.wrapS = THREE.RepeatWrapping;
  macro.wrapT = THREE.RepeatWrapping;
  macro.needsUpdate = true;
  ownedTex.push(macro);

  // 1 tile = 6 m of road. UVs are authored in metres/6 by the builder, so the
  // repeat stays at 1 and the aggregate is world-scale everywhere.
  const road = MX.standardFromPbr(asphalt, {
    name: 'apx-road',
    repeat: 1,
    color: style.tint,
    roughness: 1,
    aoIntensity: 1,
    vertexColors: true,
    normalScale: 1.05,
    envMapIntensity: style.asphalt === 'wet' ? 1.15 : 0.85,
    anisotropy: quality.anisotropy,
    detail: { scale: 4.5, strength: 0.6 },
  });
  owned.push(road);
  // placeholder until Decals hands us the atlas
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  ownedTex.push(blank);
  const uni = makeRoadShader(road, blank, macro, style);

  // ---- kerb ---------------------------------------------------------------
  const concrete = cloneSet(TX.makeConcrete(mid), ownedTex);
  const kerbTex = kerbAlbedo(mid, style.kerbA, style.kerbB);
  ownedTex.push(kerbTex);
  kerbTex.wrapS = THREE.ClampToEdgeWrapping;
  kerbTex.wrapT = THREE.RepeatWrapping;
  TX.setAnisotropy(kerbTex, quality.anisotropy);
  const kerbSet: PbrSet = {
    map: kerbTex,
    normalMap: concrete.normalMap,
    roughnessMap: concrete.roughnessMap,
    aoMap: concrete.aoMap,
    normalScale: 0.85,
  };
  const kerb = MX.standardFromPbr(kerbSet, {
    name: 'apx-kerb',
    repeat: 1,
    vertexColors: true,
    roughness: 0.92,
    aoIntensity: 0.8,
    anisotropy: quality.anisotropy,
    detail: { scale: 5, strength: 0.45 },
  });
  owned.push(kerb);

  // ---- shoulders ----------------------------------------------------------
  const shoulder = new Map<SurfaceType, THREE.MeshStandardMaterial>();
  const addShoulder = (t: SurfaceType, set: PbrSet, tint: number, rough: number, rep: number) => {
    const m = MX.standardFromPbr(set, {
      name: `apx-verge-${t}`,
      repeat: rep,
      color: tint,
      roughness: rough,
      vertexColors: true,
      anisotropy: quality.anisotropy,
      detail: { scale: 3, strength: 0.5 },
    });
    owned.push(m);
    shoulder.set(t, m);
  };
  addShoulder(SurfaceType.Grass, cloneSet(TX.makeGrass(mid), ownedTex), 0xd8e6c0, 0.95, 1.6);
  addShoulder(SurfaceType.Sand, cloneSet(TX.makeSand(mid), ownedTex), 0xffeed0, 0.98, 1.4);
  addShoulder(SurfaceType.Dirt, cloneSet(TX.makeDirt(mid), ownedTex), 0xdcc7ad, 0.97, 1.4);
  addShoulder(SurfaceType.OffRoad, cloneSet(TX.makeDirt(mid), ownedTex), 0x9b968f, 0.99, 1.2);
  addShoulder(SurfaceType.Metal, cloneSet(TX.makeMetalPanel(mid, { painted: true, color: 0x8a93a3 }), ownedTex), 0xffffff, 0.55, 1);
  addShoulder(SurfaceType.Wood, cloneSet(TX.makeWoodPlank(mid), ownedTex), 0xd8bb92, 0.9, 1);
  addShoulder(SurfaceType.Ice, cloneSet(TX.makeSnow(mid), ownedTex), 0xffffff, 0.28, 1);
  // Void/Water shoulders are never built as geometry, but keep a fallback so
  // a lookup can't return undefined.
  shoulder.set(SurfaceType.Water, shoulder.get(SurfaceType.Sand)!);
  shoulder.set(SurfaceType.Road, shoulder.get(SurfaceType.Dirt)!);
  shoulder.set(SurfaceType.Void, shoulder.get(SurfaceType.Dirt)!);
  shoulder.set(SurfaceType.Boost, shoulder.get(SurfaceType.Dirt)!);
  shoulder.set(SurfaceType.AntiGravity, shoulder.get(SurfaceType.Metal)!);
  shoulder.set(SurfaceType.Glider, shoulder.get(SurfaceType.Dirt)!);

  // ---- walls --------------------------------------------------------------
  const wall = new Map<WallStyle, THREE.Material>();

  const railMat = MX.standardFromPbr(cloneSet(TX.makeMetalPanel(mid, { painted: true, color: style.rail }), ownedTex), {
    name: 'apx-rail',
    repeat: new THREE.Vector2(3, 1),
    roughness: 0.42,
    metalness: 0.9,
    envMapIntensity: 1.25,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 6, strength: 0.5 },
  });
  owned.push(railMat);
  wall.set('guardrail', railMat);

  const concreteWall = MX.standardFromPbr(cloneSet(TX.makeConcrete(mid), ownedTex), {
    name: 'apx-wall-concrete',
    repeat: new THREE.Vector2(2, 1),
    color: 0xe2e2e0,
    roughness: 0.95,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 4, strength: 0.55 },
  });
  owned.push(concreteWall);
  wall.set('concrete', concreteWall);

  const rockWall = MX.standardFromPbr(cloneSet(TX.makeRock(mid), ownedTex), {
    name: 'apx-wall-rock',
    repeat: new THREE.Vector2(1.6, 1),
    color: 0xbfb6ab,
    roughness: 1,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 3, strength: 0.7 },
  });
  owned.push(rockWall);
  wall.set('rock', rockWall);

  const brickWall = MX.standardFromPbr(cloneSet(TX.makeBrick(mid), ownedTex), {
    name: 'apx-wall-building',
    repeat: new THREE.Vector2(2.4, 1.6),
    roughness: 0.9,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 4, strength: 0.5 },
  });
  owned.push(brickWall);
  wall.set('building', brickWall);

  const woodWall = MX.standardFromPbr(cloneSet(TX.makeWoodPlank(mid), ownedTex), {
    name: 'apx-wall-wood',
    repeat: new THREE.Vector2(2, 1),
    color: 0xb6906a,
    roughness: 0.88,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 4, strength: 0.55 },
  });
  owned.push(woodWall);
  wall.set('wood', woodWall);

  const fenceTex = chainLink(512);
  ownedTex.push(fenceTex);
  const fenceMat = new THREE.MeshStandardMaterial({
    name: 'apx-wall-fence',
    map: fenceTex,
    alphaMap: fenceTex,
    transparent: true,
    alphaTest: 0.32,
    roughness: 0.5,
    metalness: 0.75,
    side: THREE.DoubleSide,
    depthWrite: true,
    envMapIntensity: 1.1,
  });
  fenceTex.repeat.set(6, 1.2);
  owned.push(fenceMat);
  wall.set('fence', fenceMat);

  const energy = MX.emissiveGlow(style.energy, 3.4, { base: 0x0a1420, name: 'apx-energy' });
  energy.roughness = 0.25;
  energy.metalness = 0.4;
  owned.push(energy);
  wall.set('energy', energy);
  wall.set('none', concreteWall); // never instantiated, keeps lookups total

  // ---- tunnel / deck / boost ---------------------------------------------
  const tunnel = MX.standardFromPbr(cloneSet(TX.makeRock(mid), ownedTex), {
    name: 'apx-tunnel',
    repeat: new THREE.Vector2(2.2, 1.4),
    color: 0x8f8a83,
    roughness: 1,
    side: THREE.BackSide,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 3, strength: 0.75 },
  });
  owned.push(tunnel);

  const deck = MX.standardFromPbr(cloneSet(TX.makeConcrete(mid), ownedTex), {
    name: 'apx-deck',
    repeat: new THREE.Vector2(2, 2),
    color: 0x9aa0a8,
    roughness: 0.95,
    vertexColors: true,
    anisotropy: quality.anisotropy,
    detail: { scale: 3, strength: 0.5 },
  });
  owned.push(deck);

  const boost = MX.emissiveGlow(0x33c6ff, 2.4, { base: 0x06121c, name: 'apx-boost' });
  boost.roughness = 0.3;
  boost.polygonOffset = true;
  boost.polygonOffsetFactor = -2;
  boost.polygonOffsetUnits = -4;
  owned.push(boost);

  return {
    road,
    kerb,
    shoulder,
    wall,
    rail: railMat,
    energy,
    tunnel,
    deck,
    boost,
    setDecalTexture(tex: THREE.Texture) {
      uni.apxDecalMap.value = tex;
    },
    setRoadParams(p) {
      const v = uni.apxRoadParams.value;
      if (p.decal !== undefined) v.x = p.decal;
      if (p.macro !== undefined) v.y = p.macro;
      if (p.polish !== undefined) v.z = p.polish;
      if (p.wet !== undefined) v.w = p.wet;
    },
    dispose() {
      for (const m of owned) m.dispose();
      for (const t of ownedTex) t.dispose();
      owned.length = 0;
      ownedTex.length = 0;
    },
  };
}
