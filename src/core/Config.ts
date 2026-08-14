import type { QualitySettings, QualityTier, SurfaceProperties } from './Types';
import { SurfaceType } from './Types';

/** Physics runs at a fixed 120 Hz for stable, repeatable handling. */
export const FIXED_DT = 1 / 120;
/** Never step more than this many physics ticks in one frame. */
export const MAX_SUBSTEPS = 8;
/** Clamp for a single frame's delta (prevents tunnelling after a tab switch). */
export const MAX_FRAME_DT = 0.1;

export const WORLD = {
  gravity: 26.0, // m/s^2 — arcade-heavy, snappier than real gravity
  antiGravityStrength: 34.0,
  airDrag: 0.35,
  maxRacers: 12,
};

export const RACE = {
  laps: 3,
  countdownSeconds: 3.6,
  gridSpacing: 4.2,
  gridStagger: 2.4,
};

// ---------------------------------------------------------------------------
// Surface response table
// ---------------------------------------------------------------------------

export const SURFACES: Record<SurfaceType, SurfaceProperties> = {
  [SurfaceType.Road]:    { speedMul: 1.00, grip: 1.00, drag: 0.010, roughness: 0.02, particle: 'none',  sfx: 'roll_asphalt' },
  [SurfaceType.OffRoad]: { speedMul: 0.62, grip: 0.72, drag: 0.090, roughness: 0.55, particle: 'dust',  sfx: 'roll_dirt' },
  [SurfaceType.Dirt]:    { speedMul: 0.78, grip: 0.80, drag: 0.055, roughness: 0.40, particle: 'dust',  sfx: 'roll_dirt' },
  [SurfaceType.Grass]:   { speedMul: 0.60, grip: 0.70, drag: 0.100, roughness: 0.50, particle: 'grass', sfx: 'roll_grass' },
  [SurfaceType.Sand]:    { speedMul: 0.55, grip: 0.62, drag: 0.130, roughness: 0.45, particle: 'sand',  sfx: 'roll_sand' },
  [SurfaceType.Water]:   { speedMul: 0.70, grip: 0.55, drag: 0.110, roughness: 0.30, particle: 'spray', sfx: 'roll_water' },
  [SurfaceType.Ice]:     { speedMul: 1.00, grip: 0.22, drag: 0.004, roughness: 0.05, particle: 'snow',  sfx: 'roll_ice' },
  [SurfaceType.Metal]:   { speedMul: 1.02, grip: 1.05, drag: 0.008, roughness: 0.03, particle: 'sparks',sfx: 'roll_metal' },
  [SurfaceType.Wood]:    { speedMul: 0.97, grip: 0.94, drag: 0.018, roughness: 0.12, particle: 'dust',  sfx: 'roll_wood' },
  [SurfaceType.Boost]:   { speedMul: 1.00, grip: 1.00, drag: 0.010, roughness: 0.02, particle: 'none',  sfx: 'roll_asphalt' },
  [SurfaceType.AntiGravity]: { speedMul: 1.05, grip: 1.15, drag: 0.006, roughness: 0.02, particle: 'sparks', sfx: 'roll_ag' },
  [SurfaceType.Glider]:  { speedMul: 1.00, grip: 1.00, drag: 0.010, roughness: 0.00, particle: 'none',  sfx: 'roll_asphalt' },
  [SurfaceType.Void]:    { speedMul: 0.00, grip: 0.00, drag: 0.000, roughness: 0.00, particle: 'none',  sfx: 'silence' },
};

// ---------------------------------------------------------------------------
// Quality presets
// ---------------------------------------------------------------------------

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low', renderScale: 0.7, shadowMapSize: 1024, cascadeCount: 1,
    ssao: false, ssr: false, motionBlur: false, bloom: true, dof: false,
    particleBudget: 1200, anisotropy: 2, foliageDensity: 0.25, reflectionProbes: false,
  },
  medium: {
    tier: 'medium', renderScale: 0.85, shadowMapSize: 2048, cascadeCount: 2,
    ssao: true, ssr: false, motionBlur: true, bloom: true, dof: false,
    particleBudget: 4000, anisotropy: 4, foliageDensity: 0.55, reflectionProbes: true,
  },
  high: {
    tier: 'high', renderScale: 1.0, shadowMapSize: 2048, cascadeCount: 3,
    ssao: true, ssr: false, motionBlur: true, bloom: true, dof: true,
    particleBudget: 9000, anisotropy: 8, foliageDensity: 0.85, reflectionProbes: true,
  },
  /**
   * `shadowMapSize` and `cascadeCount` say 2048 / 3, NOT 4096 / 4.
   *
   * They used to claim 4096 / 4, and `Lighting` clamps them to 2048 and 3
   * (`clamp(quality.shadowMapSize, 512, 2048)` and `clamp(cascadeCount, 1, 3)`),
   * so ultra has always rendered shadows identically to `high` while the table
   * advertised something else. Two people read the preset as the shipping value
   * and were wrong.
   *
   * The clamp is the correct half and stays. Shadow depth is already the single
   * largest item in the frame — 8.39 Mpx of 14.92 Mpx rasterised, 56.2 %, and the
   * only part that does not shrink when the window does. At 4096 with 4 cascades
   * the worst frame would rasterise 67 Mpx of depth against today's 12.6, about
   * 5.3x, which no part of the 16.6 ms budget can absorb.
   *
   * Ultra still differs from high where it is affordable: SSR on, 20k particles
   * against 9k, anisotropy 16 against 8, full foliage density.
   */
  ultra: {
    tier: 'ultra', renderScale: 1.0, shadowMapSize: 2048, cascadeCount: 3,
    ssao: true, ssr: true, motionBlur: true, bloom: true, dof: true,
    particleBudget: 20000, anisotropy: 16, foliageDensity: 1.0, reflectionProbes: true,
  },
};

/** Layer assignments — keeps selective bloom / reflections cheap. */
export const LAYERS = {
  DEFAULT: 0,
  /** Emissive things that must bloom hard (boost flames, neon, sun). */
  BLOOM: 1,
  /** Excluded from reflection probes & shadow casting. */
  NO_REFLECT: 2,
  /** Rendered only in the minimap camera. */
  MINIMAP: 3,
  /** Hidden from the player's own camera (their own kart interior etc.). */
  FIRST_PERSON_HIDE: 4,
} as const;

/** Consistent render-order bands so transparency sorts predictably. */
export const RENDER_ORDER = {
  SKY: -1000,
  TERRAIN: 0,
  ROAD: 10,
  DECAL: 20,
  PROPS: 30,
  KART: 40,
  WATER: 100,
  PARTICLE_OPAQUE: 200,
  PARTICLE_ADDITIVE: 300,
  UI3D: 900,
} as const;
