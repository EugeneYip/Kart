/**
 * ============================================================================
 *  TrackDefs — the three hand-authored circuits
 * ============================================================================
 *
 *  Every control point below was placed by hand: sector by sector, with an
 *  intent comment on each one. Nothing here is generated from a formula at
 *  runtime — the numbers ARE the design. Corner radii, camber, road width and
 *  wall style change per sector because that is what gives a circuit character.
 *
 *  Reading the data:
 *    p    world position of the centreline node, metres. Y is up, -Z is the
 *         direction the grid faces.
 *    hw   half width of the drivable asphalt (so 12.5 => a 25 m road).
 *    bank camber in DEGREES. Positive banks correctly for a right-hander.
 *    shL/shR  off-road shoulder width outside the kerb, left / right.
 *    flags  TF.* bitfield — tunnels, gaps, anti-gravity, ramps, wet, grid.
 *
 *  A flag or wall style authored on node i applies to the SEGMENT STARTING at
 *  node i, so features switch on and off at node boundaries.
 *
 *  Everything else (props, boost pads, item box rows, hazards) is authored in
 *  *track space* — a normalised lap position `t` plus a lateral offset — so a
 *  prop stays glued to its corner no matter how the spline resamples.
 * ============================================================================
 */

import { SurfaceType as S } from '@/core/Types';
import { TF } from './TrackSpline';
import type { SplineDefaults, SplineNodeSpec } from './TrackSpline';

export type TrackTheme = 'coastal' | 'city' | 'volcano';
export type SkyPresetName = 'day' | 'sunset' | 'night' | 'storm' | 'volcanic';

/** A prop placed in track space. */
export interface PropSpec {
  type: string;
  /** Normalised lap position, [0,1). */
  t: number;
  /** Lateral offset from the centreline, metres. + = driver's right. */
  lat: number;
  /** Height above the road surface, metres. */
  up?: number;
  /** Extra yaw about the road up axis, radians. */
  yaw?: number;
  scale?: number;
  /** Repeat every `step` (normalised lap units) until `end`. */
  step?: number;
  end?: number;
  /** Also place a mirrored copy at -lat. */
  mirror?: boolean;
}

export interface BoostPadSpec {
  t: number;
  lat: number;
  /** Metres across the road. */
  width: number;
  /** Metres along the road. */
  length: number;
}

export interface ItemRowSpec {
  t: number;
  count: number;
  /** Total lateral span of the row, metres. Defaults to most of the road. */
  spread?: number;
}

/**
 * P0d-D1: `traffic` is gone. Non-race vehicles entered the frame from behind the
 * player — the one hazard nobody could see coming, which is why it read as unfair
 * rather than hard. Removing the kind, not just the instance, so it cannot be
 * re-authored by accident.
 */
export interface HazardSpec {
  kind: 'oil' | 'boulder' | 'fireball' | 'slider' | 'snapper';
  t: number;
  lat?: number;
  span?: number;
  speed?: number;
}

/** Palette + material knobs handed to RoadMaterial / TrackBuilder. */
export interface RoadStyle {
  asphalt: 'clean' | 'worn' | 'wet';
  /** Albedo tint multiplied into the asphalt. */
  tint: number;
  /** Rumble strip stripe colours (alternating). */
  kerbA: number;
  kerbB: number;
  /** Painted road-edge line. */
  line: number;
  /** Verge / shoulder tint. */
  verge: number;
  /** Guardrail metal. */
  rail: number;
  /** Emissive colour of `energy` walls and anti-gravity plating. */
  energy: number;
  /** 0..1 strength of the baked tyre-polished racing line. */
  racingLine: number;
  /** Vertex-colour AO strength near walls and kerbs. */
  ao: number;
}

export interface TrackDef {
  id: string;
  name: string;
  subtitle: string;
  theme: TrackTheme;
  skyPreset: SkyPresetName;
  laps: number;
  /** Deterministic seed for terrain + scatter. */
  terrainSeed: number;
  /** World Y of the water plane, or null for no water. */
  waterLevel: number | null;
  fogColor: number;
  fogDensity: number;
  road: RoadStyle;
  defaults?: Partial<SplineDefaults>;
  nodes: SplineNodeSpec[];
  props: PropSpec[];
  boostPads: BoostPadSpec[];
  itemRows: ItemRowSpec[];
  hazards: HazardSpec[];
}

// ===========================================================================
//  1. SUNSET COASTLINE  —  1.62 km, golden hour
// ===========================================================================
//
//  Shape: a long clockwise loop hugging a headland. Beachfront straight, a
//  270 m decreasing-radius climb up the cliff, a clifftop chute into the
//  latest braking point on the lap (a 47 m-radius point hairpin), then a dark
//  descending left through the rock tunnel into a tight beach-town esses.
//  Promenade kink, cove jump with a glider, then a long banked sea-wall
//  right-hander that opens onto the widest road on the circuit.
//
//  Elevation: 0 m at the beach, 32 m at the clifftop.
//
const SUNSET_NODES: SplineNodeSpec[] = [
  // ---- S1 start/finish beachfront straight. Widest road on the lap (25 m):
  //      three-wide into turn 1 is the whole point.
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.00, -42.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', flags: TF.Grid },
  { p: [0.0, 0.01, -84.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', flags: TF.Grid },
  { p: [0.0, 0.01, -126.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', flags: TF.Grid },
  { p: [0.0, 0.02, -168.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail' },
  { p: [0.0, 0.03, -210.0], hw: 12.5, shL: 9, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', tag: 'brake for T1' },

  // ---- S2a turn-in. R ~ 250 m: so gentle you can take it flat, which is the
  //      trap — it sets up the tightening exit 190 m later.
  { p: [1.8, 2.71, -239.9], hw: 11.5, bank: 4, shL: 6, shR: 8, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock', tag: 'Cliffside entry' },
  { p: [7.2, 5.39, -269.4], hw: 11.5, bank: 4, shL: 6, shR: 8, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [16.2, 8.08, -298.1], hw: 11.5, bank: 4, shL: 6, shR: 8, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  // ---- S2b mid-corner. R ~ 225 m, camber up to 8 deg — the road starts
  //      helping you just as the radius starts hurting.
  { p: [27.9, 11.09, -323.8], hw: 11, bank: 8, shL: 4, shR: 7, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [42.8, 14.11, -348.0], hw: 11, bank: 8, shL: 4, shR: 7, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [60.6, 17.14, -370.0], hw: 11, bank: 8, shL: 4, shR: 7, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  // ---- S2c DECREASING RADIUS EXIT. R falls to 131 m and the road narrows to
  //      19 m. Open the throttle where instinct says to and the sea wall on
  //      the left takes the nose.
  { p: [77.8, 19.16, -385.7], hw: 9.5, bank: 9, shL: 3, shR: 6, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock', tag: 'decreasing radius' },
  { p: [97.6, 21.19, -398.2], hw: 9.5, bank: 9, shL: 3, shR: 6, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [119.2, 23.21, -406.9], hw: 9.5, bank: 9, shL: 3, shR: 6, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },

  // ---- S3 clifftop chute. Flat out, still climbing, ocean 25 m below on the
  //      left. Brake boards at the far end.
  { p: [148.1, 25.49, -415.1], hw: 10.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock', tag: 'clifftop chute' },
  { p: [177.2, 27.77, -422.2], hw: 10.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [206.6, 30.05, -428.2], hw: 10.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock' },
  { p: [236.2, 32.33, -433.1], hw: 10.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'rock', tag: 'brake board' },

  // ---- S4 the point hairpin. R 47 m, 17 m wide, rock on both sides.
  //      Latest braking on the lap and the best place to hang a banana.
  { p: [254.8, 31.94, -432.2], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'HAIRPIN' },
  { p: [271.5, 31.54, -424.2], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [284.0, 31.15, -410.4], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [290.2, 30.76, -392.9], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'apex' },
  { p: [289.2, 30.36, -374.4], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [281.2, 29.97, -357.6], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [267.4, 29.58, -345.2], hw: 8.5, bank: 6, shL: 2.5, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'tunnel mouth' },

  // ---- S5 the tunnel. A long descending LEFT (note the negative camber: the
  //      road falls away from the corner) through solid rock. 18 m wide,
  //      1.6 m shoulders, and 14 m of drop in 165 m.
  { p: [245.1, 27.28, -329.1], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel, tag: 'TUNNEL' },
  { p: [225.9, 24.99, -309.4], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [210.4, 22.69, -286.7], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [199.1, 20.40, -261.7], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [192.2, 18.10, -235.0], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [190.1, 15.81, -207.6], hw: 9, bank: -5, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel, tag: 'tunnel exit' },

  // ---- S6 beach-town esses: left, right, left through the old harbour
  //      streets. 17 m between building faces; the kerbs are the fast line.
  { p: [193.3, 13.35, -182.8], hw: 8.5, bank: -8, shL: 2, shR: 2, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building', tag: 'town esses L' },
  { p: [202.0, 10.88, -159.4], hw: 8.5, bank: -8, shL: 2, shR: 2, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building' },
  { p: [209.6, 8.92, -138.2], hw: 8.5, bank: 9, shL: 2, shR: 2, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building', tag: 'town esses R' },
  { p: [211.4, 6.96, -115.8], hw: 8.5, bank: 9, shL: 2, shR: 2, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building' },
  { p: [212.9, 4.99, -90.8], hw: 9, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building', tag: 'town esses L2' },
  { p: [219.5, 3.03, -66.7], hw: 9, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.Dirt, wallL: 'building', wallR: 'building' },

  // ---- S7 promenade kink. Fast right, 6 deg of camber, looks far worse from
  //      the cockpit than it is. Flat if you commit.
  { p: [225.6, 2.07, -45.9], hw: 10.5, bank: 6, shL: 4, shR: 4, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'fence', tag: 'promenade kink' },
  { p: [227.8, 1.10, -24.4], hw: 10.5, bank: 6, shL: 4, shR: 4, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'fence' },
  { p: [226.1, 0.13, -2.8], hw: 10.5, bank: 6, shL: 4, shR: 4, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'fence' },

  // ---- S8 the cove jump. The road blends up into a lip (no kerbs, no rails),
  //      ~23 m of open water, glider on the way down onto a sand spit.
  //
  //  *** READ THIS BEFORE MOVING ANY OF THESE SEVEN NODES ***
  //  This jump was unclearable at every speed from 22 to 40 m/s (measured, and
  //  the playtester reported the section as impassable). Three things were wrong
  //  and all three are load-bearing:
  //
  //  1. The LANDING was 1.54 m ABOVE the lip. Gravity here is 26 m/s^2, so a
  //     kart leaving a lip at 40 m/s and 4.8 degrees rises 0.6 m at apex — it can
  //     never regain height. The landing must sit ~7 m BELOW the lip.
  //  2. The LAUNCH PITCH was 4.8 degrees, because with Catmull-Rom the tangent at
  //     the lip is the chord from the node *before* it to the node *after* it,
  //     and the node after it was 34 m away across the void. That is why there is
  //     now a control point INSIDE the gap ('void arc'): it is what lets the lip
  //     tangent (11 deg, from node 'cove ramp b' -> 'void arc') be steep while the
  //     landing is still far below. Delete it and the launch goes flat again.
  //  3. The boost pad was authored at t=0.712, which is 2 m PAST the lip: 11 m of
  //     an 18 m pad hung in mid-air over the water and nobody ever got the boost.
  //     It now sits wholly on the ramp — see `boostPads` below.
  //
  //  The void arc also keeps the centreline near the flight path, which matters:
  //  `isOutOfBounds` respawns anything more than 7 m below the centreline while
  //  over a `TF.Gap`, so a centreline that flies straight while the kart falls
  //  triggers a respawn in mid-air.
  { p: [222.8, 1.80, 16.9], hw: 11, bank: 0, shL: 2, shR: 2, shoulderSurface: S.Sand, wallL: 'none', wallR: 'none', flags: TF.Ramp, tag: 'cove ramp' },
  { p: [219.5, 4.40, 36.7], hw: 11, bank: 0, shL: 2, shR: 2, shoulderSurface: S.Sand, wallL: 'none', wallR: 'none', flags: TF.Ramp, tag: 'cove ramp b' },
  { p: [216.1, 9.20, 56.4], hw: 11, bank: 0, shL: 0, shR: 0, shoulderSurface: S.Water, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'GAP (lip)' },
  { p: [214.3, 10.30, 66.8], hw: 11, bank: 0, shL: 0, shR: 0, shoulderSurface: S.Water, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'void arc' },
  { p: [212.4, 2.20, 77.0], hw: 11.5, bank: 0, shL: 6, shR: 6, shoulderSurface: S.Sand, wallL: 'none', wallR: 'none', flags: TF.Glider, tag: 'landing' },
  { p: [209.4, 1.60, 100.0], hw: 11.5, bank: 0, shL: 6, shR: 6, shoulderSurface: S.Sand, wallL: 'none', wallR: 'none', flags: TF.Glider },
  { p: [205.6, 1.10, 126.0], hw: 11.5, bank: 0, shL: 6, shR: 6, shoulderSurface: S.Sand, wallL: 'none', wallR: 'none', flags: TF.Glider },
  { p: [200.5, 0.84, 149.1], hw: 11.5, bank: 0, shL: 6, shR: 6, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'guardrail' },

  // ---- S9 sea-wall right-hander. 128 deg of turn at R 74 m with 11 deg of
  //      banking and a 24 m road: the only corner you can genuinely run
  //      three-wide through, so this is the overtaking corner.
  { p: [191.0, 0.70, 174.9], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete', tag: 'SEA WALL - overtake' },
  { p: [172.8, 0.55, 195.4], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete' },
  { p: [148.3, 0.41, 208.0], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete' },
  { p: [121.0, 0.26, 210.7], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete' },
  { p: [94.5, 0.11, 203.3], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete' },
  { p: [72.5, -0.04, 186.8], hw: 12, bank: 11, shL: 7, shR: 5, shoulderSurface: S.Sand, wallL: 'guardrail', wallR: 'concrete' },

  // ---- S10 beach straight. Opens back to 25 m, boost strip on the ideal
  //      line, slipstream all the way to the flag.
  { p: [51.1, -0.03, 160.2], hw: 12.5, bank: 4, shL: 8, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail', tag: 'beach straight' },
  { p: [33.1, -0.02, 131.2], hw: 12.5, bank: 4, shL: 8, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail' },
  { p: [18.8, -0.01, 100.2], hw: 12.5, bank: 4, shL: 8, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail' },
  { p: [8.4, -0.01, 67.7], hw: 12.5, bank: 4, shL: 8, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail' },
  { p: [2.1, 0.0, 34.1], hw: 12.5, bank: 2, shL: 8, shR: 7, shoulderSurface: S.Sand, wallL: 'fence', wallR: 'guardrail' },
];

// ===========================================================================
//  2. NEON METROPOLIS  —  1.55 km, night city
// ===========================================================================
//
//  Street circuit. A hard 49 m-radius Turn 1, then the narrowest road in the
//  game (15 m between building faces) through a service alley. Two long
//  boulevards feed a full banked 180 around the arcology tower (R 55 m,
//  25 deg of camber) which flows straight into anti-gravity plating and an
//  84-degree WALL RIDE up the tower face. Descend, cross the rain-slick
//  straight (the overtake), then a flyover jump and a monorail chicane.
//
const NEON_NODES: SplineNodeSpec[] = [
  // ---- N1 grid straight, under the neon gantries.
  { p: [0.0, 0.00, 0.0], hw: 12, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.00, -41.8], hw: 12, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.01, -83.5], hw: 12, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'brake for T1' },

  // ---- N2 Turn 1. R 49 m off the fastest point on the lap: the hardest
  //      braking zone in the game and lap-1 carnage guaranteed.
  { p: [0.0, 0.01, -125.3], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'TURN 1' },
  { p: [3.3, 0.02, -143.4], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [12.8, 0.04, -159.1], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- N3 the service alley. 15 m wide, 0.8 m of shoulder, building faces
  //      for walls, no light. Brush a wall here and the lap is gone.
  { p: [27.2, 0.05, -170.5], hw: 7.5, shL: 0.8, shR: 0.8, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Dark, tag: 'ALLEY' },
  { p: [49.4, 0.07, -182.1], hw: 7.5, shL: 0.8, shR: 0.8, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Dark },
  { p: [71.8, 0.09, -193.2], hw: 7.5, bank: -6, shL: 0.8, shR: 0.8, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Dark, tag: 'alley kink L' },
  { p: [90.3, 0.11, -206.2], hw: 7.5, bank: -6, shL: 0.8, shR: 0.8, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Dark },
  { p: [103.8, 0.14, -224.2], hw: 8.5, bank: 7, shL: 1.2, shR: 1.2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'alley exit R' },
  { p: [116.5, 0.16, -242.8], hw: 8.5, bank: 7, shL: 1.2, shR: 1.2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },

  // ---- N4 the neon boulevard. 24 m wide, dead straight, item boxes right
  //      across it. Two blocks of full throttle.
  { p: [132.9, 0.19, -258.3], hw: 12, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'boulevard' },
  { p: [163.0, 0.22, -281.1], hw: 12, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [192.8, 0.25, -304.2], hw: 12, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [222.4, 0.29, -327.5], hw: 12, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [251.8, 0.32, -351.1], hw: 12, bank: 3, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'tower approach' },
  { p: [281.0, 0.36, -375.0], hw: 12, bank: 3, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [310.0, 0.40, -399.1], hw: 12, bank: 3, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [338.8, 0.44, -423.5], hw: 12, bank: 3, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'arcology gate' },

  // ---- N5 THE TOWER. A full 180 at R 55 m with 25 deg of camber wrapped
  //      around the arcology. The camber pays for the radius: hold the
  //      throttle and the banking does the work.
  { p: [367.4, 0.48, -448.1], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete', tag: 'THE TOWER' },
  { p: [384.0, 1.19, -458.2], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [403.0, 1.89, -462.2], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [422.3, 2.61, -459.6], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [439.6, 3.32, -450.8], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [452.9, 4.03, -436.7], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [460.9, 4.74, -418.9], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [462.4, 5.45, -399.6], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },
  { p: [457.5, 6.17, -380.8], hw: 11.5, bank: 25, shL: 2, shR: 4, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'concrete' },

  // ---- N6 anti-gravity. The plating engages, the bank rolls 46 -> 84 deg
  //      and the road climbs the tower face. Energy rails both sides.
  { p: [446.5, 6.88, -364.8], hw: 10, bank: 46, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity, tag: 'ANTI-GRAV' },
  { p: [434.2, 8.60, -351.2], hw: 10, bank: 46, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [422.7, 10.31, -337.0], hw: 10, bank: 46, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [412.1, 12.02, -322.1], hw: 10, bank: 84, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity, tag: 'WALL RIDE' },
  { p: [402.1, 13.82, -306.3], hw: 10, bank: 84, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [393.0, 15.62, -290.0], hw: 10, bank: 84, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [384.8, 17.42, -273.1], hw: 10, bank: 84, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [377.6, 19.21, -255.9], hw: 10, bank: 34, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity, tag: 'bank unwinds' },
  { p: [371.9, 19.93, -240.3], hw: 10, bank: 34, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },
  { p: [366.9, 20.64, -224.4], hw: 10, bank: 34, shL: 1.2, shR: 1.2, surface: S.AntiGravity, shoulderSurface: S.Metal, wallL: 'energy', wallR: 'energy', flags: TF.AntiGravity },

  // ---- N7 descent ramp. Long left, 16 m of drop, negative camber, blind
  //      exit onto the wet straight.
  { p: [362.5, 21.35, -208.4], hw: 10.5, bank: -12, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'descent' },
  { p: [357.6, 17.39, -189.0], hw: 10.5, bank: -12, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [352.6, 13.44, -169.7], hw: 10.5, bank: -12, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [347.5, 9.48, -150.5], hw: 10.5, bank: -12, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- N8 rain-slick straight. 25 m wide, standing water, twin boost
  //      strips. THE overtaking spot on the circuit.
  { p: [342.3, 5.52, -131.2], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet, tag: 'WET STRAIGHT' },
  { p: [330.0, 5.56, -91.6], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [315.0, 5.60, -53.0], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },

  // ---- N9 up onto the flyover. Banked right, still wet, narrow shoulders.
  { p: [297.2, 5.64, -15.5], hw: 11, bank: 12, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge | TF.Wet, tag: 'flyover ramp' },
  { p: [283.7, 7.35, 3.4], hw: 11, bank: 12, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge | TF.Wet },
  { p: [265.3, 9.05, 17.6], hw: 11, bank: 12, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge | TF.Wet },

  // ---- N10 flyover jump. Kicker, ~21 m gap over the plaza, glider, lower deck.
  //      Same three defects as the coastal cove jump and the same fix — see the
  //      long note on S8 in SUNSET_NODES. The landing deck used to sit 0.01 m
  //      ABOVE the lip with a 1.6 degree launch: unclearable at any speed.
  { p: [243.6, 9.90, 26.0], hw: 11, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'none', wallR: 'none', flags: TF.Bridge | TF.Ramp, tag: 'flyover kicker' },
  { p: [224.0, 11.70, 30.4], hw: 11, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'none', wallR: 'none', flags: TF.Bridge | TF.Ramp },
  { p: [204.5, 15.40, 34.8], hw: 11, shL: 0, shR: 0, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'GAP (lip)' },
  { p: [194.2, 16.40, 37.1], hw: 11, shL: 0, shR: 0, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'void arc' },
  { p: [183.6, 9.20, 39.5], hw: 11, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge | TF.Glider, tag: 'landing deck' },
  { p: [159.7, 8.60, 44.9], hw: 11, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge | TF.Glider },

  // ---- N11 monorail chicane. Left-right under the elevated line. The kerbs
  //      are the fast way through — the geometry rewards riding them.
  { p: [140.2, 9.89, 49.3], hw: 9.5, bank: -8, shL: 1.5, shR: 1.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark, tag: 'chicane L' },
  { p: [123.4, 8.91, 54.4], hw: 9.5, bank: -8, shL: 1.5, shR: 1.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark },
  { p: [107.7, 7.93, 62.0], hw: 9.5, bank: 9, shL: 1.5, shR: 1.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark, tag: 'chicane R' },
  { p: [91.7, 6.95, 68.9], hw: 9.5, bank: 9, shL: 1.5, shR: 1.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark },

  // ---- N12 the final corner. 100 deg of right at R 66 m that keeps
  //      tightening onto the grid straight. Overcook it and you lose the
  //      slipstream for the whole next lap.
  { p: [74.4, 5.96, 71.7], hw: 11.5, bank: 12, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'final corner' },
  { p: [51.6, 4.78, 68.9], hw: 11.5, bank: 12, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [30.9, 3.59, 59.0], hw: 11.5, bank: 12, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [14.3, 2.39, 43.0], hw: 11.5, bank: 12, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [3.7, 1.20, 22.7], hw: 11.5, bank: 6, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
];

// ===========================================================================
//  3. VOLCANO RUSH  —  1.53 km, 50 m of elevation
// ===========================================================================
//
//  The most vertical circuit. Basalt start straight, a climbing right, a
//  first-gear switchback, then a COLLAPSED BRIDGE jump over a lava river.
//  Banked crater-rim right along the lip, a lava field whose entire inside is
//  loose rock (a genuine off-road SHORTCUT: shorter but slower), then a real
//  SPIRAL DESCENT — a 360-degree helix, R 54 m, that drops 40 m and passes
//  directly under its own upper deck. Out through a lava tube and the esses.
//
const VOLCANO_NODES: SplineNodeSpec[] = [
  // ---- V1 start straight over the basalt flats.
  { p: [0.0, 0.00, 0.0], hw: 12, shL: 7, shR: 7, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.00, -39.9], hw: 12, shL: 7, shR: 7, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Grid },
  { p: [0.0, 0.00, -79.9], hw: 12, shL: 7, shR: 7, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [0.0, 0.00, -119.8], hw: 12, shL: 7, shR: 7, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'brake' },

  // ---- V2 the ash rise. R 55 m and 20 m of climb: the exit is uphill and
  //      blind, so power down early or lose half a second.
  { p: [0.0, 0.00, -159.7], hw: 11, bank: 10, shL: 5, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'ASH RISE' },
  { p: [4.0, 4.00, -180.3], hw: 11, bank: 10, shL: 5, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [15.4, 8.00, -197.9], hw: 11, bank: 10, shL: 5, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [32.6, 12.00, -210.0], hw: 11, bank: 10, shL: 5, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [53.1, 16.00, -214.7], hw: 11, bank: 10, shL: 5, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },

  // ---- V3 the switchback. Tight steep LEFT at R 66 m, still climbing 22 m,
  //      and the crest at the exit unloads the wheels completely.
  { p: [73.8, 20.00, -211.4], hw: 9, bank: -10, shL: 3, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'SWITCHBACK' },
  { p: [94.6, 25.50, -207.4], hw: 9, bank: -10, shL: 3, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [115.7, 31.00, -210.1], hw: 9, bank: -10, shL: 3, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [134.8, 36.50, -219.3], hw: 9, bank: -10, shL: 3, shR: 3, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'crest' },

  // ---- V4 the broken bridge. Old timber-and-basalt deck, no barriers, the
  //      centre span is gone. ~20 m of nothing with a lava river underneath.
  //      The deck humps up into the break (that is what makes it clearable —
  //      see the long note on S8 in SUNSET_NODES) and the far deck sits 6 m
  //      lower, where the span dropped when it collapsed.
  { p: [150.1, 41.00, -234.0], hw: 10, shL: 1.2, shR: 1.2, surface: S.Wood, shoulderSurface: S.Wood, wallL: 'wood', wallR: 'wood', flags: TF.Bridge | TF.Ramp, tag: 'BROKEN BRIDGE' },
  { p: [167.8, 43.60, -255.1], hw: 10, shL: 1.2, shR: 1.2, surface: S.Wood, shoulderSurface: S.Wood, wallL: 'wood', wallR: 'wood', flags: TF.Bridge | TF.Ramp },
  { p: [187.6, 49.20, -274.2], hw: 10, shL: 0, shR: 0, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'COLLAPSED SPAN (lip)' },
  { p: [194.6, 50.10, -280.4], hw: 10, shL: 0, shR: 0, wallL: 'none', wallR: 'none', flags: TF.Gap | TF.Glider, tag: 'void arc' },
  { p: [202.6, 42.40, -287.6], hw: 10.5, shL: 1.2, shR: 1.2, surface: S.Wood, shoulderSurface: S.Wood, wallL: 'wood', wallR: 'wood', flags: TF.Bridge | TF.Glider, tag: 'far deck' },
  { p: [226.8, 42.20, -306.8], hw: 10.5, shL: 1.2, shR: 1.2, surface: S.Wood, shoulderSurface: S.Wood, wallL: 'wood', wallR: 'wood', flags: TF.Bridge | TF.Glider },

  // ---- V5 the crater rim. 167 deg of banked right at R 67 m along the lip.
  //      No wall on the outside — that side is the crater. 8 m shoulder is
  //      all you get before the drop.
  { p: [247.6, 42.00, -320.6], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none', tag: 'CRATER RIM' },
  { p: [271.9, 43.14, -329.0], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },
  { p: [297.6, 44.29, -326.8], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },
  { p: [320.1, 45.43, -314.3], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },
  { p: [335.6, 46.57, -293.8], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },
  { p: [341.4, 47.71, -268.8], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },
  { p: [336.6, 48.86, -243.5], hw: 11.5, bank: 15, shL: 4, shR: 8, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'none' },

  // ---- V6 the lava field. A long left whose ENTIRE inside is drivable loose
  //      rock (24 m of it) — cut the corner for a shorter line at 62 % speed.
  //      Brave on lap 3, suicide on lap 1 in traffic.
  { p: [322.0, 50.00, -222.4], hw: 10, bank: -6, shL: 24, shR: 4, shoulderSurface: S.OffRoad, wallL: 'none', wallR: 'rock', tag: 'SHORTCUT' },
  { p: [301.8, 49.25, -200.2], hw: 10, bank: -6, shL: 24, shR: 4, shoulderSurface: S.OffRoad, wallL: 'none', wallR: 'rock' },
  { p: [285.3, 48.50, -175.1], hw: 10, bank: -6, shL: 24, shR: 4, shoulderSurface: S.OffRoad, wallL: 'none', wallR: 'rock' },
  { p: [272.8, 47.75, -147.7], hw: 10, bank: -6, shL: 24, shR: 4, shoulderSurface: S.OffRoad, wallL: 'none', wallR: 'rock' },

  // ---- V6b caldera chute. One breath of straight before the spiral.
  { p: [264.8, 47.00, -118.8], hw: 11, bank: 5, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'caldera chute' },
  { p: [259.0, 47.00, -94.5], hw: 11, bank: 5, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [251.3, 47.00, -70.7], hw: 11, bank: 5, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },

  // ---- V7 the SPIRAL. A true 360-degree helix, R 54 m, banked 19 deg,
  //      dropping 40 m in 340 m of road. Quarter 3 passes ~20 m directly
  //      beneath quarter 1, so this is also the stacked-road stress test.
  { p: [241.7, 47.00, -47.6], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge, tag: 'SPIRAL q1' },
  { p: [232.2, 45.00, -33.4], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [218.9, 43.00, -23.0], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [202.9, 41.00, -17.1], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [185.9, 39.00, -16.5], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [169.6, 37.00, -21.1], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge, tag: 'SPIRAL q2' },
  { p: [155.4, 35.00, -30.6], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [144.9, 33.00, -44.0], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [139.1, 31.00, -60.0], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [138.5, 29.00, -77.0], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [143.1, 27.00, -93.3], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge | TF.Dark, tag: 'SPIRAL q3 (under q1)' },
  { p: [152.6, 25.00, -107.4], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge | TF.Dark },
  { p: [166.0, 23.00, -117.9], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge | TF.Dark },
  { p: [182.0, 21.00, -123.7], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge | TF.Dark },
  { p: [198.9, 19.00, -124.4], hw: 9.5, bank: 19, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge | TF.Dark },
  { p: [215.3, 17.00, -119.7], hw: 9.5, bank: 17, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge, tag: 'SPIRAL q4' },
  { p: [229.4, 15.00, -110.2], hw: 9.5, bank: 17, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [239.9, 13.00, -96.9], hw: 9.5, bank: 17, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [245.7, 11.00, -80.9], hw: 9.5, bank: 17, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },
  { p: [246.4, 9.00, -63.9], hw: 9.5, bank: 17, shL: 1.4, shR: 1.4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'guardrail', flags: TF.Bridge },

  // ---- V8 the lava tube. Tunnel with glowing cracks under the wheels.
  { p: [241.7, 7.00, -47.6], hw: 9.5, bank: 10, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel, tag: 'LAVA TUBE' },
  { p: [229.4, 6.00, -27.2], hw: 9.5, bank: 10, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [213.0, 5.00, -10.0], hw: 9.5, bank: 10, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },
  { p: [193.3, 4.00, 3.2], hw: 9.5, bank: 10, shL: 1.6, shR: 1.6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', flags: TF.Tunnel },

  // ---- V9 basalt esses. Left then right, and the right-hander's exit drops
  //      away from you into the final kink.
  { p: [171.1, 3.00, 11.9], hw: 10, bank: -10, shL: 4, shR: 4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'esses L' },
  { p: [146.1, 3.00, 23.4], hw: 10, bank: -10, shL: 4, shR: 4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [126.4, 3.00, 42.7], hw: 10, bank: 12, shL: 4, shR: 4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'esses R' },
  { p: [108.3, 1.50, 59.8], hw: 10, bank: 12, shL: 4, shR: 4, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },

  // ---- V10 final kink. Boost strip on the exit line, fires you at the flag.
  { p: [85.1, 0.00, 69.3], hw: 11.5, bank: 10, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock', tag: 'final kink' },
  { p: [60.1, 0.00, 70.0], hw: 11.5, bank: 10, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [36.5, 0.00, 61.9], hw: 11.5, bank: 10, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [17.1, 0.00, 46.1], hw: 11.5, bank: 10, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
  { p: [4.4, 0.00, 24.6], hw: 11.5, bank: 5, shL: 6, shR: 6, shoulderSurface: S.Dirt, wallL: 'rock', wallR: 'rock' },
];

// ---------------------------------------------------------------------------
// Track definitions
// ---------------------------------------------------------------------------

export const TRACKS: Record<string, TrackDef> = {
  sunsetCoastline: {
    id: 'sunsetCoastline',
    name: 'Sunset Coastline',
    subtitle: 'Cliffs, a cove jump and a hairpin in the dark',
    theme: 'coastal',
    skyPreset: 'sunset',
    laps: 3,
    terrainSeed: 20482,
    waterLevel: -1.6,
    fogColor: 0xffb989,
    fogDensity: 0.0016,
    road: {
      // The key light on this track is a low sunset sun (#fff1d6, r/b 1.49 in
      // linear) and the env is an orange sky, so ANY warmth in the road's own
      // albedo compounds into gold. 'worn' is both the lightest and the warmest
      // asphalt recipe (base 0.372/0.366/0.352 + a full crack field); 'clean'
      // is darker and very slightly cool (0.286/0.288/0.302). Tint and verge
      // dust are held neutral-to-cool for the same reason — see the block
      // comment on ROAD_FRAG in RoadMaterial.ts.
      asphalt: 'clean',
      tint: 0xe4e8ec,
      kerbA: 0xd8402f,
      kerbB: 0xf2efe6,
      line: 0xf6f2e6,
      verge: 0x8a7f6c,
      rail: 0xb9c3cc,
      energy: 0x53d8ff,
      racingLine: 0.85,
      ao: 0.9,
    },
    defaults: { wallL: 'guardrail', wallR: 'guardrail', shoulderSurface: S.Grass },
    nodes: SUNSET_NODES,
    props: [
      // start/finish furniture
      { type: 'startGantry', t: 0.0, lat: 0, up: 0 },
      { type: 'grandstand', t: 0.005, lat: -27, up: 0, scale: 1.15 },
      { type: 'grandstand', t: 0.03, lat: -27, up: 0, scale: 1.0 },
      { type: 'crowdStand', t: 0.018, lat: 25, up: 0 },
      { type: 'balloonArch', t: 0.055, lat: 0, up: 9 },
      // beachfront palms + umbrellas along the straight
      { type: 'palm', t: 0.01, lat: -26, step: 0.012, end: 0.12, mirror: false, scale: 1.1 },
      { type: 'beachUmbrella', t: 0.02, lat: -33, step: 0.02, end: 0.11 },
      { type: 'lifeguardTower', t: 0.07, lat: -36 },
      // cliffside sweeper: rock spires outside, marker boards inside
      { type: 'brakeBoard', t: 0.118, lat: -16 },
      { type: 'rockSpire', t: 0.15, lat: 26, step: 0.011, end: 0.25, scale: 1.3 },
      { type: 'pine', t: 0.16, lat: 22, step: 0.02, end: 0.26 },
      { type: 'signChevron', t: 0.215, lat: -14, step: 0.006, end: 0.245 },
      // clifftop chute
      { type: 'cypress', t: 0.28, lat: 19, step: 0.014, end: 0.34 },
      // 13 left only 0.75 m of verge against a 10.5 m half-width (the board is
      // 3.5 m wide and `lat` is its centre). 14.5 clears it.
      { type: 'brakeBoard', t: 0.345, lat: 14.5 },
      { type: 'brakeBoard', t: 0.352, lat: 14.5 },
      // hairpin: tyre stacks and chevrons
      { type: 'tyreStack', t: 0.372, lat: 12.5, step: 0.004, end: 0.40 },
      { type: 'signChevron', t: 0.375, lat: -12, step: 0.005, end: 0.40 },
      { type: 'tunnelPortal', t: 0.408, lat: 0 },
      { type: 'tunnelPortal', t: 0.505, lat: 0, yaw: Math.PI },
      // beach town
      // P0d "overly thick decorative structures covering the track". Measured
      // (`.probe-tmp/crowding.ts`): `authored:townhouse` + its glow pass filled
      // **8.5 % of the whole frame** across 42 of 202 chase stations and the
      // worst instance came 0.5 m INSIDE the tarmac — by far the biggest single
      // offender on this circuit, and the cause of the five worst stations
      // (38-41 % of frame each, t=0.56-0.61). The house is 9.8 m across and was
      // centred 15 m out against an 8.5-9.0 m half-width, i.e. 1.1 m of verge.
      // Pushed to 18 (4.1 m of verge) and thinned 26 -> 18 instances.
      { type: 'townHouse', t: 0.52, lat: 20, step: 0.013, end: 0.63, mirror: true },
      { type: 'streetLamp', t: 0.525, lat: -12, step: 0.014, end: 0.63 },
      { type: 'planter', t: 0.56, lat: 11, step: 0.008, end: 0.60 },
      // promenade + cove
      { type: 'palmCluster', t: 0.655, lat: -18, step: 0.016, end: 0.70 },
      { type: 'buoy', t: 0.735, lat: -30, step: 0.01, end: 0.775 },
      { type: 'sailboat', t: 0.75, lat: 62, scale: 1.4 },
      { type: 'sailboat', t: 0.77, lat: -74, scale: 1.1 },
      // sea wall + beach straight
      { type: 'seaWall', t: 0.80, lat: 17, step: 0.007, end: 0.885 },
      { type: 'flagPole', t: 0.815, lat: -18, step: 0.012, end: 0.88 },
      { type: 'palm', t: 0.90, lat: -27, step: 0.011, end: 0.99 },
      { type: 'crowdStand', t: 0.955, lat: 25, step: 0.02, end: 0.995 },
    ],
    boostPads: [
      { t: 0.905, lat: 0, width: 8, length: 16 },
      { t: 0.945, lat: -3.5, width: 6, length: 14 },
      { t: 0.66, lat: 4, width: 6, length: 12 },
      // ON the cove ramp, not past its lip. At t=0.712 (the old value) 13 m of
      // this 18 m pad hung in mid-air over the water: the strip was drawn at a
      // road height that does not exist there and no kart ever collected the
      // boost it needs to clear the jump. The ramp runs d=1104..1145 on a
      // ~1613 m lap, so the pad has to sit inside t=0.692..0.703.
      { t: 0.698, lat: 0, width: 12, length: 16 },
    ],
    // Three rows per lap, MK8-style. Was six (26 boxes); a playtester reported
    // constant attacks made a normal race impossible. Rows sit before the
    // overtaking spots, not on every straight.
    itemRows: [
      { t: 0.30, count: 5 },
      { t: 0.60, count: 3, spread: 11 },
      { t: 0.885, count: 5 },
    ],
    // Difficulty pass after playtest: NOTHING sits on the racing line any more.
    // `lat: 0` put a 40 m traffic sweep dead centre, which a playtester called
    // out as an obstacle in the middle of the road. Hazards now live off-line
    // where they punish a bad line rather than blocking the good one, and
    // speeds are down ~35%.
    hazards: [
      { kind: 'oil', t: 0.436, lat: -8.5 },
      { kind: 'boulder', t: 0.20, lat: 9.5, span: 12, speed: 4 },
      { kind: 'snapper', t: 0.83, lat: -13 },
    ],
  },

  neonMetropolis: {
    id: 'neonMetropolis',
    name: 'Neon Metropolis',
    subtitle: 'Wall-ride the arcology, then pray for grip',
    theme: 'city',
    skyPreset: 'night',
    laps: 3,
    terrainSeed: 90117,
    waterLevel: null,
    fogColor: 0x0f1730,
    fogDensity: 0.0034,
    road: {
      asphalt: 'wet',
      tint: 0xdfe4ee,
      kerbA: 0x2b3450,
      kerbB: 0xd9e6ff,
      line: 0xeaf2ff,
      verge: 0x4a5162,
      rail: 0x8d99ad,
      energy: 0x38e0ff,
      racingLine: 0.7,
      ao: 1.05,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: NEON_NODES,
    props: [
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'neonSign', t: 0.006, lat: 17, step: 0.01, end: 0.075, mirror: true },
      { type: 'crowdStand', t: 0.02, lat: -23, step: 0.022, end: 0.07 },
      { type: 'towerBlock', t: 0.01, lat: 46, step: 0.018, end: 0.20, mirror: true, scale: 1.3 },
      { type: 'brakeBoard', t: 0.074, lat: -14 },
      { type: 'tyreStack', t: 0.086, lat: 12.5, step: 0.004, end: 0.105 },
      // the alley
      // `lat` is the block's CENTRE, and the recipe randomises its own half-width
      // (now 3.8–5.2 m plus a 0.4 m roof cap; it was 4.5–6.5 m). At the original
      // `lat: 10.5` the near wall landed at 3.6 m against a 7.5–8.5 m road half
      // width, so these stood up to 5.3 m INSIDE the drivable road and hid 40 %+
      // of the road ahead on 18 of 259 stations through the alley S-bend.
      //
      // ---- P0d, second pass. `lat: 17` fixed the OCCLUSION (sightline: neon is
      // now 1.8 % of road-ahead hidden, 0 stations over 40 %) but not the BULK,
      // which is what the owner actually complained about. Measured with
      // `.probe-tmp/crowding.ts`: the body pass filled 8.56 % of the frame and
      // the `:metal` pass another 5.23 % — **13.8 % of every frame was alley
      // block**, the largest single figure anywhere in the game, over 38 of 194
      // stations, with 30 instances at 0.6 m of clear verge. Pushed to 21 and
      // thinned 30 -> 18. Slimmer recipe + wider offset + half the count.
      { type: 'alleyBlock', t: 0.115, lat: 21, step: 0.010, end: 0.20, mirror: true },
      // 10 left 0.19 m of verge against an 8.9 m half-width; the vent stack is
      // 1.8 m across. Same story for the barrels at 0.15 m.
      { type: 'ventStack', t: 0.13, lat: 12, step: 0.014, end: 0.195 },
      { type: 'barrelStack', t: 0.145, lat: -12, step: 0.017, end: 0.19 },
      { type: 'holoAd', t: 0.16, lat: 0, up: 11 },
      // boulevard
      // `streetlight` filled 2.03 % of frame across 108 of 194 stations at 1.2 m
      // of verge — not thick, but relentless. Thinned ~25 %.
      { type: 'streetLamp', t: 0.21, lat: 17, step: 0.015, end: 0.40, mirror: true },
      { type: 'holoAd', t: 0.235, lat: 0, up: 13, step: 0.035, end: 0.39 },
      { type: 'skyscraper', t: 0.22, lat: 74, step: 0.03, end: 0.42, mirror: true, scale: 1.6 },
      { type: 'brakeBoard', t: 0.395, lat: -15 },
      // the tower
      { type: 'arcologyTower', t: 0.455, lat: -62, scale: 2.4 },
      // `bank: 25` through the tower, so this 13 m column leaned 5.5 m inward as
      // it rose: at lat -15 its head sat at lat -9.5 against a 10-11.5 m
      // half-width, i.e. over the tarmac. Same mechanism as `agPylon` below, one
      // third the roll. -19 keeps the whole column outside the carriageway, and
      // takes 2.49 % of the left-edge frame with it (`.probe-tmp/edgefill.ts`).
      { type: 'energyPylon', t: 0.415, lat: -19, step: 0.005, end: 0.53 },
      // ---- anti-grav / wall ride ------------------------------------------
      //
      // `lat` IS MEASURED ALONG THE BINORMAL, AND THIS SECTION ROLLS TO 88 DEG.
      //
      // N6 is authored `bank: 84` and the spline overshoots slightly, so the
      // carriageway's roll measures 87-89 deg from t=0.550 to t=0.587. There the
      // binormal is within 2 deg of VERTICAL, so an authored `lat` buys altitude
      // instead of sideways clearance: a `lat: 13.5` anchor sits **0.3 m** from
      // the centreline in plan and 13.5 m down the wall, and `agPylon` — a 9.3 m
      // vertical column — then grows along world +Y straight back through the
      // carriageway. Measured on the real scene: 10 instances over d=846-930 m,
      // each occupying **5.8 m of the 20 m road** at a rise of -1.4 m, i.e.
      // *behind the surface the kart is driving on*. Only the `+lat` copy does
      // it: the binormal's vertical component is negative here, so the +side
      // column leans back toward the centreline as it rises while the mirrored
      // -side one leans away.
      //
      // This is NOT the `alleyBlock` failure mode. `agPylon`'s built mesh is
      // 2.00 m across (half-width 1.00 m) against a 27 m corridor, so it does
      // not overrun its authored `lat` at all — `crowding.ts`'s lat audit reads
      // +2.13 m of verge. A flat-road width audit cannot see this defect,
      // because the defect is the roll, and that is why the probe finding was
      // written off as "a false positive of a flat-road test on tube geometry".
      // Re-run in the road's own frame the same section shows 23 % of the
      // visible road ahead hidden at t=0.598 and puts six `agpylon` instances in
      // neon's twelve worst occluders.
      //
      // A vertical column cannot be authored clear of a vertical wall with `lat`
      // (it would need |lat| > 19.3 m just to keep its tip off the tarmac, by
      // which point it is a silhouette in the sky rather than a marker). So the
      // run is split around the vertical section, which keeps its energy rails
      // on both walls, its glowing anti-gravity plating and the holoAd overhead.
      // `lat` also goes 13.5 -> 19 on the ramps: at 51 deg of roll a 9.3 m
      // column at 13.5 leaned in to lat 6.3 — 3.7 m over the tarmac at 5 m up —
      // and 19 keeps the whole column outside the carriageway at every roll the
      // run now covers.
      { type: 'agPylon', t: 0.527, lat: 19, step: 0.008, end: 0.543, mirror: true },
      { type: 'agPylon', t: 0.599, lat: 19, step: 0.008, end: 0.645, mirror: true },
      { type: 'holoAd', t: 0.58, lat: -20, up: 4, step: 0.02, end: 0.64 },
      // wet straight
      { type: 'streetLamp', t: 0.70, lat: 18, step: 0.016, end: 0.79, mirror: true },
      { type: 'billboard', t: 0.725, lat: -22, scale: 1.3 },
      { type: 'billboard', t: 0.765, lat: 22, scale: 1.3 },
      // flyover + monorail
      { type: 'bridgePylon', t: 0.80, lat: 0, up: -12, step: 0.012, end: 0.835 },
      // The pylon carries a 25.4 m wide beam yoke, so `lat: -15` put its far arm
      // 2.5 m over the tarmac and 2.09 % of the frame across 31 stations. -19
      // keeps the monorail crossing the sky above the road without the yoke
      // hanging into it.
      { type: 'monorailPylon', t: 0.885, lat: -19, step: 0.013, end: 0.945 },
      { type: 'trafficLight', t: 0.90, lat: 12 },
      { type: 'crowdStand', t: 0.965, lat: -23, step: 0.018, end: 0.998 },
    ],
    boostPads: [
      { t: 0.715, lat: -5, width: 7, length: 18 },
      { t: 0.715, lat: 5, width: 7, length: 18 },
      { t: 0.762, lat: 0, width: 9, length: 16 },
      { t: 0.30, lat: 0, width: 10, length: 14 },
    ],
    // Three rows per lap (was seven / 31 boxes).
    itemRows: [
      { t: 0.245, count: 5 },
      { t: 0.50, count: 3, spread: 14 },
      { t: 0.775, count: 5 },
    ],
    // The last `traffic` sweep on any circuit is gone (P0d-D1). Two hazards left
    // and they are 60 %+ of a lap apart, so nothing can chain-hit.
    hazards: [
      { kind: 'oil', t: 0.72, lat: 7 },
      { kind: 'slider', t: 0.155, lat: -9, span: 10, speed: 3 },
    ],
  },

  volcanoRush: {
    id: 'volcanoRush',
    name: 'Volcano Rush',
    subtitle: 'A broken bridge, a lava shortcut and a 40 m helix',
    theme: 'volcano',
    skyPreset: 'volcanic',
    laps: 3,
    terrainSeed: 6613,
    waterLevel: null,
    fogColor: 0x3a1c18,
    fogDensity: 0.0042,
    road: {
      // P0d "the volcano track is too dark". `tint` multiplies the asphalt
      // albedo map, so this line is a direct scale on every lighting term.
      // Measured (`.probe-tmp/volcdark.ts`): at 0xbdb6b2 the resolved road
      // albedo was lum 0.0321 against coastal's 0.0544 and neon's 0.0524 —
      // volcano's tarmac was authored 41 % darker than either of the circuits
      // nobody complained about, and then lit by a sun at 11 deg elevation that
      // delivers only sin(11) = 0.19 of the key to an up-facing plane. The two
      // compounded. 0xdcd8d2 brings the albedo to lum 0.0480, still the darkest
      // of the three (basalt, not concrete) but no longer a special case.
      // Held near-neutral rather than warm: the key is a saturated #ff7a45 and
      // the env is an orange sky, and per the ROAD_FRAG note in RoadMaterial.ts
      // warmth in the albedo compounds with both into gold.
      asphalt: 'clean',
      tint: 0xdcd8d2,
      kerbA: 0x3a2320,
      kerbB: 0xe4b98a,
      line: 0xf0e2c8,
      // `verge` is a MULTIPLIER on the asphalt albedo over the outer quarter of
      // the road (see `shadeRoad` in TrackBuilder). At 0x4b3a33 that was a 0.29x
      // darkening of exactly the band the driver reads the road edge from, on the
      // darkest circuit in the game. Lifted so the edge stays visible; it is
      // still clearly dust-tinted.
      verge: 0x6f5a4e,
      rail: 0x8b7d74,
      energy: 0xff7328,
      racingLine: 0.8,
      ao: 0.9,
    },
    defaults: { wallL: 'rock', wallR: 'rock', shoulderSurface: S.Dirt },
    nodes: VOLCANO_NODES,
    // =======================================================================
    //  P0d — "overly thick decorative structures ... especially noticeable on
    //  the volcano track". Measured before/after with `.probe-tmp/crowding.ts`
    //  (frame fill at the real chase pose) and `.probe-tmp/sightline.ts`
    //  (occlusion of the road ahead). Volcano was the worst circuit on both:
    //  11.29 % of the frame filled by props with under 6 m of clear verge,
    //  85 of 193 stations over 10 %, and 4.1 % of the road-ahead hidden with
    //  7 stations over 40 %.
    //
    //  The offenders, by near-road frame pixels, and what each one got:
    //    spiralpylon   4.42 %   -8.5 m verge   the helix's own supports stood
    //                                          beside the LOWER carriageway
    //    ashplume      2.34 %   22x40x22 m     pushed out
    //    basaltcolumn  1.90 %   44 instances   thinned, slimmed, pushed out
    //    obsidian      0.62 %   111 stations   pushed out (recipe scale capped)
    // =======================================================================
    props: [
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'crowdStand', t: 0.015, lat: -26, step: 0.02, end: 0.06 },
      // The owner's screenshots: "dark basalt columns crowding both sides". The
      // start straight carried 20 of them at lat +-24 on a 0.01 step at scale
      // 1.2 — a continuous 4 m-thick, 9 m-tall wall down both verges. 7 per side
      // at 27 with the scale back to 1.0 keeps the Giant's-Causeway silhouette
      // and stops it reading as a corridor. The recipe is also slimmer now.
      { type: 'basaltColumn', t: 0.01, lat: 27, step: 0.016, end: 0.10, mirror: true },
      { type: 'brakeBoard', t: 0.075, lat: -15 },
      // ash rise + switchback
      { type: 'deadTree', t: 0.115, lat: 19, step: 0.013, end: 0.20 },
      // The plume is a 22 x 40 x 22 m column of ash and it was the single biggest
      // shadow caster on the circuit as well as 2.34 % of frame. At -46 it still
      // dominates the skyline over the switchback; it just no longer leans over
      // the road.
      { type: 'ashPlume', t: 0.14, lat: -46, step: 0.03, end: 0.22 },
      { type: 'signChevron', t: 0.175, lat: 12, step: 0.005, end: 0.205 },
      // broken bridge
      { type: 'bridgePylon', t: 0.235, lat: 0, up: -22, step: 0.014, end: 0.265 },
      { type: 'lavaFountain', t: 0.262, lat: 0, up: -26, scale: 1.6 },
      { type: 'bridgePylon', t: 0.30, lat: 0, up: -22, step: 0.014, end: 0.325 },
      // crater rim
      { type: 'lavaFountain', t: 0.36, lat: 44, up: -6, scale: 2.2 },
      // `obsidianSpire` is folded into `buildVolcano`'s shard cluster, whose own
      // scatter caps the anchor scale now. These two runs were at 1.4 / 1.6 on a
      // cluster ~2.5 m in half-width, so the far end of a spire reached 7.9 m
      // inside the tarmac on the tightest instances. Pushed out and calmed down.
      { type: 'obsidianSpire', t: 0.34, lat: -27, step: 0.014, end: 0.44, scale: 1.15 },
      { type: 'ashPlume', t: 0.40, lat: 56, up: -4, step: 0.02, end: 0.45 },
      // lava field shortcut - marked with warning posts
      // -11 left the post 0.30 m INSIDE an 11.0 m half-width, which is why
      // `Props.clearRoadSurface` was pushing four of these clear every load.
      { type: 'warningPost', t: 0.465, lat: -12.5, step: 0.006, end: 0.535 },
      { type: 'lavaRock', t: 0.47, lat: -22, step: 0.008, end: 0.54, scale: 1.1 },
      // ---- the spiral. THE worst prop in the game ------------------------
      // A 47 m tall, 4 m thick column, authored at lat 0 / up -18 to hold the
      // helix up. The helix passes directly OVER the lava-tube straight, so the
      // first few pylons of the run descend right beside that lower carriageway:
      // instance #0 projected to lat +1.8 on a 9.5 m half-width road (7.7 m
      // inside it) and hid **100 % of the visible road ahead** at t=0.826, 87 %
      // at t=0.825 and 70 % at t=0.874 — all 7 of volcano's over-40 % stations
      // were this one run. It also filled 4.42 % of the frame across 90 of 193
      // stations, more than any other prop on any circuit except neon's alley.
      //
      // `lat` cannot fix it: lat is measured from the helix, and the helix is
      // where the pylon belongs. The fix is to start the run AFTER the overlap
      // (t 0.60 -> 0.638) and halve the density, so the flyover still visibly
      // stands on something without a column growing out of the road below.
      { type: 'spiralPylon', t: 0.638, lat: 0, up: -18, step: 0.014, end: 0.79 },
      { type: 'obsidianSpire', t: 0.62, lat: -32, step: 0.022, end: 0.78, scale: 1.3 },
      // lava tube + esses
      { type: 'tunnelPortal', t: 0.805, lat: 0 },
      { type: 'tunnelPortal', t: 0.865, lat: 0, yaw: Math.PI },
      // 24 columns at +-17 on a 10.0-11.5 m half-width road left 3.5 m of verge
      // and 1.90 % of frame through the esses. 14 at +-21.
      { type: 'basaltColumn', t: 0.88, lat: 21, step: 0.017, end: 0.99, mirror: true },
      { type: 'crowdStand', t: 0.965, lat: -26, step: 0.02, end: 0.998 },
    ],
    boostPads: [
      { t: 0.955, lat: 0, width: 9, length: 16 },
      { t: 0.235, lat: 0, width: 14, length: 18 }, // bridge launch
      { t: 0.545, lat: 4, width: 7, length: 14 },
      { t: 0.79, lat: 0, width: 8, length: 14 },
    ],
    // Three rows per lap (was seven / 31 boxes).
    itemRows: [
      { t: 0.33, count: 5 },
      { t: 0.575, count: 3, spread: 12 },
      { t: 0.90, count: 5 },
    ],
    // The lat-0 boulder at 8 m/s over a 20 m span was the worst offender
    // reported — a fast heavy object crossing the racing line. Removed.
    hazards: [
      { kind: 'fireball', t: 0.355, lat: 10, span: 16, speed: 5 },
      { kind: 'boulder', t: 0.50, lat: -15, span: 18, speed: 4 },
      { kind: 'oil', t: 0.845, lat: 7 },
    ],
  },
};

export const TRACK_ORDER: readonly string[] = ['sunsetCoastline', 'neonMetropolis', 'volcanoRush'];
export const DEFAULT_TRACK = 'sunsetCoastline';

export function getTrackDef(id: string | undefined): TrackDef {
  if (id && TRACKS[id]) return TRACKS[id];
  return TRACKS[DEFAULT_TRACK];
}
