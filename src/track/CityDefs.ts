/**
 * ============================================================================
 *  CityDefs — the CITY SERIES: Boston, Taipei, Tokyo
 * ============================================================================
 *
 *  Three street circuits, registered from `TrackDefs.ts` (two lines there, so
 *  this file can be worked on without touching the original three circuits).
 *  Everything about the `TrackDef` shape, the units and the authoring space is
 *  documented at the top of `TrackDefs.ts` — read that first. The short version:
 *  nodes are world-space centreline control points in metres, and props / pads /
 *  item rows / hazards are authored in TRACK SPACE (a lap fraction `t` plus a
 *  lateral offset `lat`).
 *
 *  ---------------------------------------------------------------------------
 *  HOW THESE THREE CENTRELINES WERE BUILT — and why they cannot have a kink
 *  ---------------------------------------------------------------------------
 *  Each circuit is a closed polygon of eight corner waypoints, every vertex
 *  filleted with a circular arc of an authored radius, and the node list below
 *  is that path sampled: one node at every straight/arc boundary plus interiors
 *  at <= 14 degrees of turn or <= 34 m apart. Three consequences worth knowing
 *  before moving a number:
 *
 *   * **Closure is structural, not fitted.** The polygon closes, so the path
 *     closes: measured closure error is 0.0000 m and the heading error 0.00000
 *     on all three. There is no seam node to keep in sync.
 *   * **Straight -> arc -> straight is tangent continuous**, so there is no
 *     kink to smooth over. `.probe-tmp/citycheck.ts` walks the built spline and
 *     asserts it: worst turn-rate step, min corner radius, max grade, and that
 *     no two consecutive nodes are further apart than the sampler allows.
 *   * **Elevation is a periodic profile smoothed over the node ring**, then
 *     shifted so node 0 is exactly y = 0. Grades come out under 5 % everywhere.
 *     World (0, 0, 0) being the road surface at the S/F line is deliberate: it
 *     is the one place a stray identity matrix shows up (see `poseMotionProps`
 *     in `Props.ts`), so it stays the road and nothing else.
 *
 *  The generator was a throwaway; the numbers ARE the design, exactly as in
 *  `TrackDefs.ts`. Editing a node by hand is fine — the probe will tell you if
 *  you have introduced a discontinuity.
 *
 *  ---------------------------------------------------------------------------
 *  NO GAPS, NO ANTI-GRAVITY
 *  ---------------------------------------------------------------------------
 *  Deliberate. `TrackDefs.ts` carries two long notes about jumps that were
 *  unclearable at every speed from 22 to 40 m/s, and one about a `lat: 13.5`
 *  pylon that grew through the carriageway because an 88-degree bank turns a
 *  lateral offset into altitude. Both defect classes are structural to those
 *  features. A city series does not need either to be a city series, so these
 *  three use tunnels, elevated decks, standing water and camber instead, and
 *  every bank here stays at or under 11 degrees.
 *
 *  ---------------------------------------------------------------------------
 *  LANDMARKS AND `lat`
 *  ---------------------------------------------------------------------------
 *  `lat` is a CENTRE offset, and a recipe wider than its own `lat` stands inside
 *  the road — that is the `alleyBlock` defect, five metres of building on the
 *  racing line. Every landmark recipe in `Props.ts` states its built
 *  ACROSS-ROAD half-extent in its comment, and each placement below is authored
 *  as `lat = halfExtent + halfWidth + clear verge`. The numbers are checked by
 *  `.probe-tmp/crowding.ts`'s lat audit, which reads the extents off the real
 *  built geometry rather than off these comments.
 * ============================================================================
 */

import { SurfaceType as S } from '@/core/Types';
import { TF } from './TrackSpline';
import type { SplineNodeSpec } from './TrackSpline';
import type { TrackDef } from './TrackDefs';

// ===========================================================================
//  4. BOSTON HARBOR  —  1.63 km, cold blue daylight
// ===========================================================================
//
//  Clockwise. A 330 m boulevard through the start/finish line into the hardest
//  braking zone on the lap (R58, 78 degrees), then the narrowest road here
//  (18 m) down a brick brownstone terrace, a kink, and straight into a 137 m
//  covered TUNNEL. Out onto the harbour front — the widest road and the
//  overtaking spot — up a banked ramp onto the CABLE-STAYED BRIDGE with its two
//  obelisk towers, off the deck down a tight descending right, along the plaza
//  under the gold dome, a left, and the green stadium wall on the outside of a
//  banked right. The final sweeper runs under the glass tower onto the
//  boulevard.
//
//  Elevation: 0 m at the line, 6.8 m on the bridge deck.
//
const BOSTON_NODES: SplineNodeSpec[] = [
  // ---- S1 start/finish boulevard
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.03, -30.2], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.13, -60.4], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.26, -90.6], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.40, -120.8], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.54, -151.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.68, -181.2], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'brake for T1' },

  // ---- S2 Turn 1 — the hard one
  { p: [0.0, 0.81, -211.4], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'TURN 1' },
  { p: [1.5, 0.94, -224.3], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [5.8, 1.06, -236.7], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [12.8, 1.18, -247.7], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [22.1, 1.30, -256.9], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [33.2, 1.44, -263.8], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S3 Back Bay — brownstone terrace, narrowest road on the lap
  { p: [45.6, 1.61, -268.0], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'BROWNSTONES' },
  { p: [74.8, 1.81, -274.4], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [104.0, 2.00, -280.8], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [133.3, 2.15, -287.3], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [162.5, 2.23, -293.7], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [191.7, 2.23, -300.1], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [221.0, 2.18, -306.5], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'brownstone kink' },
  { p: [233.0, 2.12, -307.9], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [245.1, 2.04, -307.0], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [256.8, 1.93, -303.7], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },

  // ---- S4 the tunnel
  { p: [267.6, 1.77, -298.2], hw: 9.5, shL: 1.6, shR: 1.6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Tunnel, tag: 'TUNNEL' },
  { p: [296.5, 1.56, -279.8], hw: 9.5, shL: 1.6, shR: 1.6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Tunnel },
  { p: [325.4, 1.34, -261.3], hw: 9.5, shL: 1.6, shR: 1.6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Tunnel },
  { p: [354.3, 1.14, -242.9], hw: 9.5, shL: 1.6, shR: 1.6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Tunnel },

  // ---- S5 harbour entry
  { p: [383.1, 0.99, -224.4], hw: 11, bank: 9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'guardrail', wallR: 'concrete', tag: 'harbour entry' },
  { p: [395.9, 0.90, -214.4], hw: 11, bank: 9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'guardrail', wallR: 'concrete' },
  { p: [406.5, 0.85, -202.1], hw: 11, bank: 9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'guardrail', wallR: 'concrete' },
  { p: [414.6, 0.88, -188.0], hw: 11, bank: 9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'guardrail', wallR: 'concrete' },

  // ---- S6 harbour front — the overtake
  { p: [419.8, 1.05, -172.7], hw: 12, bank: 2, shL: 5, shR: 7, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'HARBOUR FRONT' },
  { p: [426.3, 1.44, -144.6], hw: 12, bank: 2, shL: 5, shR: 7, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [432.8, 2.11, -116.5], hw: 12, bank: 2, shL: 5, shR: 7, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [439.3, 3.00, -88.5], hw: 12, bank: 2, shL: 5, shR: 7, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },

  // ---- S7 bridge approach
  { p: [445.9, 3.97, -60.4], hw: 11.5, bank: 6, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'bridge ramp' },
  { p: [448.3, 4.85, -43.0], hw: 11.5, bank: 6, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [447.4, 5.49, -25.4], hw: 11.5, bank: 6, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- S8 THE BRIDGE — twin obelisk towers, cable fans
  { p: [443.4, 5.80, -8.3], hw: 11, bank: 3, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'THE BRIDGE' },
  { p: [432.6, 5.73, 24.3], hw: 11, bank: 3, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [421.7, 5.34, 56.9], hw: 11, bank: 3, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- S9 bridge off-ramp, descending right
  { p: [410.8, 4.77, 89.6], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'off-ramp' },
  { p: [406.1, 4.23, 99.6], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [399.1, 3.86, 108.1], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [390.3, 3.63, 114.8], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [380.2, 3.48, 119.1], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [369.3, 3.37, 121.0], hw: 9.5, bank: 8, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- S10 dome plaza
  { p: [358.3, 3.29, 120.1], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'DOME PLAZA' },
  { p: [328.4, 3.26, 114.2], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [298.5, 3.27, 108.3], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S11 State House left
  { p: [268.6, 3.28, 102.4], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'State House left' },
  { p: [257.0, 3.27, 101.5], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [245.4, 3.22, 103.4], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [234.6, 3.15, 107.9], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [225.1, 3.06, 114.7], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S12 stadium approach
  { p: [217.4, 2.93, 123.6], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [197.9, 2.77, 152.7], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S13 the green wall
  { p: [178.4, 2.61, 181.8], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'GREEN WALL' },
  { p: [169.1, 2.46, 192.8], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [157.6, 2.32, 201.5], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [144.5, 2.20, 207.6], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [130.4, 2.08, 210.6], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [116.0, 1.95, 210.6], hw: 10.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [102.0, 1.79, 207.3], hw: 11, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [75.9, 1.61, 198.3], hw: 11, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S14 glass tower sweep onto the boulevard
  { p: [49.8, 1.43, 189.3], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'glass tower sweep' },
  { p: [36.0, 1.25, 182.8], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [23.8, 1.10, 173.7], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [13.7, 0.95, 162.2], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [6.2, 0.81, 149.0], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [1.6, 0.66, 134.5], hw: 11.5, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- S15 run to the line
  { p: [0.0, 0.50, 119.3], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'run to the line' },
  { p: [0.0, 0.33, 89.5], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.17, 59.7], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.05, 29.8], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
];

// ===========================================================================
//  5. TAIPEI CIRCUIT  —  1.60 km, dusk under the supertall
// ===========================================================================
//
//  Anticlockwise, and almost entirely left-handed: seven of the eight corners
//  turn left, which makes the single right-hander at t=0.72 the one corner
//  nobody has a rhythm for. Turn 1 drops straight into the NIGHT MARKET, 17 m
//  wide between shophouse faces with lantern strings overhead. Out along the
//  river, then the signature corner: a 150 m-radius banked left, 123 m long,
//  with the tiered supertall standing on the inside of it. A banked left onto
//  the MEMORIAL PLAZA (the flag is here), a tight left out of it, the lone
//  right, and then a 154-degree double-apex left with the mountains behind it.
//
//  Elevation: 0 m at the line, 9 m on the mountain side.
//
const TAIPEI_NODES: SplineNodeSpec[] = [
  // ---- T1 start/finish boulevard under the supertall
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.06, -31.3], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.24, -62.6], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.47, -93.9], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.72, -125.1], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.95, -156.4], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'brake for T1' },

  // ---- T2 Turn 1 — left, into the market district
  { p: [0.0, 1.15, -187.7], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'TURN 1' },
  { p: [-1.4, 1.31, -200.1], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-5.5, 1.44, -211.9], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-12.1, 1.55, -222.5], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-20.8, 1.65, -231.3], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-31.4, 1.77, -238.0], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T3 night market strip — narrowest road on the lap
  { p: [-43.1, 1.89, -242.2], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'NIGHT MARKET' },
  { p: [-74.1, 1.99, -249.6], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-105.2, 2.04, -256.9], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-136.3, 2.01, -264.3], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-167.3, 1.93, -271.6], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },

  // ---- T4 market exit
  { p: [-198.4, 1.82, -279.0], hw: 9.5, bank: -6, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', tag: 'market exit' },
  { p: [-212.6, 1.72, -280.8], hw: 9.5, bank: -6, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [-226.9, 1.65, -279.8], hw: 9.5, bank: -6, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [-240.7, 1.63, -275.8], hw: 9.5, bank: -6, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },

  // ---- T5 riverside
  { p: [-253.3, 1.68, -269.1], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'riverside' },
  { p: [-276.9, 1.81, -253.4], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-300.5, 2.00, -237.7], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-324.0, 2.22, -222.0], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },

  // ---- T6 the long sweeper — R150, the supertall on the inside
  { p: [-347.6, 2.45, -206.3], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail', tag: 'TOWER SWEEPER' },
  { p: [-363.9, 2.67, -193.7], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },
  { p: [-378.3, 2.91, -179.1], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },
  { p: [-390.5, 3.19, -162.6], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },
  { p: [-400.4, 3.50, -144.6], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },
  { p: [-407.8, 3.84, -125.4], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },

  // ---- T7 tower straight
  { p: [-412.5, 4.22, -105.4], hw: 12, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'tower straight' },
  { p: [-418.3, 4.61, -69.5], hw: 12, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-424.1, 4.98, -33.5], hw: 12, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T8 banked left onto the plaza
  { p: [-429.9, 5.29, 2.5], hw: 11, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'plaza entry' },
  { p: [-431.0, 5.54, 20.4], hw: 11, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-428.4, 5.75, 38.1], hw: 11, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-422.3, 5.94, 54.9], hw: 11, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T9 memorial plaza
  { p: [-412.8, 6.13, 70.1], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'MEMORIAL PLAZA' },
  { p: [-391.5, 6.32, 98.0], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-370.1, 6.51, 125.8], hw: 11, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T10 plaza exit — tight left
  { p: [-348.7, 6.67, 153.7], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'plaza exit' },
  { p: [-341.2, 6.79, 161.3], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-332.1, 6.89, 166.9], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-321.9, 6.98, 170.1], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-311.2, 7.11, 170.8], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T11 mountain approach
  { p: [-300.7, 7.30, 168.9], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-270.7, 7.56, 159.5], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-240.6, 7.85, 150.1], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },

  // ---- T12 the one right-hander on the lap
  { p: [-210.6, 8.12, 140.8], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail', tag: 'THE RIGHT' },
  { p: [-200.8, 8.33, 139.0], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-190.9, 8.44, 139.5], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-181.4, 8.43, 142.3], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-172.8, 8.29, 147.3], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-165.6, 8.00, 154.2], hw: 9, bank: 8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-160.2, 7.57, 162.6], hw: 9.5, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },

  // ---- T13 the double-apex left, 154 deg in 110 m
  { p: [-143.6, 7.07, 197.1], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail', tag: 'DOUBLE APEX' },
  { p: [-136.5, 6.58, 208.3], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-127.2, 6.13, 217.7], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-116.0, 5.73, 224.9], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-103.5, 5.36, 229.3], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-90.4, 4.99, 231.0], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-77.2, 4.62, 229.7], hw: 10.5, bank: -11, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-64.6, 4.23, 225.6], hw: 10.5, bank: -9, shL: 3.5, shR: 3.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },

  // ---- T14 final sweeper
  { p: [-45.5, 3.83, 216.8], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'final sweeper' },
  { p: [-30.3, 3.41, 207.7], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-17.6, 2.99, 195.3], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-8.0, 2.56, 180.3], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-2.0, 2.13, 163.6], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- T15 run to the line
  { p: [0.0, 1.67, 145.9], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'run to the line' },
  { p: [0.0, 1.20, 116.7], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.75, 87.5], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.36, 58.4], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.10, 29.2], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
];

// ===========================================================================
//  6. TOKYO NEON  —  1.54 km, night and standing water
// ===========================================================================
//
//  Clockwise, wet. The start/finish straight runs UNDER the city expressway —
//  the deck crosses it 9.6 m up, and the last 60 m before Turn 1 are flagged
//  Dark for it. Turn 1 feeds the SCRAMBLE CROSSING: 22 m between building faces
//  with three-storey screens on both sides and standing water on the road. Then
//  up the ramp onto the ELEVATED EXPRESSWAY — 260 m of banked deck 9 m in the
//  air, shoulders cut back to a kerb and a barrier — down an off-ramp to street
//  level, and into the shrine district: a run of vermilion torii along the
//  inside of a tight left. The lattice tower stands over the penultimate right,
//  the broadcast spire over everything.
//
//  Elevation: 0 m at the line, 9.2 m on the expressway deck.
//
const TOKYO_NODES: SplineNodeSpec[] = [
  // ---- K1 start/finish straight, expressway overhead
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, 0.05, -34.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.18, -68.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.34, -102.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.50, -136.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark },
  { p: [0.0, 0.65, -170.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Dark, tag: 'under the expressway' },

  // ---- K2 Turn 1
  { p: [0.0, 0.78, -204.0], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet, tag: 'TURN 1' },
  { p: [1.3, 0.88, -215.8], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [5.2, 0.96, -227.1], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [11.4, 1.03, -237.2], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [19.6, 1.12, -245.7], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [29.6, 1.29, -252.2], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },

  // ---- K3 the scramble crossing — screens both sides, standing water
  { p: [40.7, 1.58, -256.4], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Wet, tag: 'SCRAMBLE' },
  { p: [68.9, 2.02, -263.6], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Wet },
  { p: [97.2, 2.59, -270.8], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Wet },
  { p: [125.5, 3.22, -278.0], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Wet },
  { p: [153.8, 3.85, -285.2], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', flags: TF.Wet },

  // ---- K4 crossing exit
  { p: [182.0, 4.42, -292.4], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', flags: TF.Wet, tag: 'crossing exit' },
  { p: [196.2, 4.93, -294.2], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', flags: TF.Wet },
  { p: [210.3, 5.42, -292.7], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', flags: TF.Wet },
  { p: [223.7, 5.94, -287.9], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', flags: TF.Wet },

  // ---- K5 expressway ramp, climbing
  { p: [235.6, 6.55, -280.0], hw: 10.5, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', tag: 'expressway ramp' },
  { p: [262.4, 7.21, -257.4], hw: 10.5, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete' },
  { p: [289.2, 7.82, -234.7], hw: 10.5, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [315.9, 8.28, -212.1], hw: 10.5, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- K6 THE ELEVATED EXPRESSWAY
  { p: [342.7, 8.57, -189.4], hw: 10.5, bank: 9, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'EXPRESSWAY' },
  { p: [357.2, 8.74, -174.0], hw: 10.5, bank: 9, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [367.7, 8.81, -155.6], hw: 10.5, bank: 9, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [373.8, 8.82, -135.4], hw: 10.5, bank: 2, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [379.2, 8.75, -105.1], hw: 10.5, bank: 2, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [384.7, 8.61, -74.9], hw: 10.5, bank: 2, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [390.1, 8.39, -44.7], hw: 10.5, bank: 2, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- K7 deck sweeper
  { p: [395.5, 8.08, -14.5], hw: 10.5, bank: 10, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'deck sweeper' },
  { p: [397.0, 7.65, 3.2], hw: 10.5, bank: 10, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [395.5, 7.11, 20.8], hw: 10.5, bank: 10, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [390.8, 6.46, 37.9], hw: 10.5, bank: 10, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },

  // ---- K8 down the off-ramp
  { p: [383.2, 5.75, 53.9], hw: 10, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'off-ramp' },
  { p: [369.2, 5.06, 77.7], hw: 10, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete' },
  { p: [355.2, 4.46, 101.4], hw: 10, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete' },

  // ---- K9 tight right at street level
  { p: [341.2, 4.01, 125.2], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'street level' },
  { p: [332.9, 3.72, 136.1], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [322.4, 3.52, 144.7], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [310.0, 3.37, 150.6], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [296.7, 3.26, 153.5], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [283.0, 3.15, 153.2], hw: 9.5, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- K10 shrine approach
  { p: [269.8, 3.07, 149.7], hw: 9.5, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },
  { p: [247.2, 2.98, 140.7], hw: 9.5, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },

  // ---- K11 the shrine left — torii both sides
  { p: [224.6, 2.91, 131.7], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark, tag: 'TORII LEFT' },
  { p: [214.8, 2.83, 129.2], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark },
  { p: [204.7, 2.77, 129.0], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark },
  { p: [194.8, 2.70, 131.3], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark },
  { p: [185.8, 2.63, 135.9], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark },
  { p: [178.1, 2.54, 142.5], hw: 9, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', flags: TF.Dark },
  { p: [172.2, 2.44, 150.8], hw: 9.5, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- K12 lattice-tower right
  { p: [154.8, 2.31, 183.0], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'LATTICE TOWER' },
  { p: [145.3, 2.18, 196.3], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [132.8, 2.05, 207.0], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [118.2, 1.93, 214.5], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [102.2, 1.80, 218.2], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [85.8, 1.65, 217.9], hw: 10, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [69.9, 1.50, 213.7], hw: 10.5, bank: 2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },

  // ---- K13 final corner
  { p: [44.2, 1.34, 203.5], hw: 11, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet, tag: 'final corner' },
  { p: [29.5, 1.19, 195.6], hw: 11, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [17.2, 1.04, 184.4], hw: 11, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [7.8, 0.89, 170.6], hw: 11, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [2.0, 0.73, 155.0], hw: 11, bank: 10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },

  // ---- K14 run to the line
  { p: [0.0, 0.55, 138.5], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet, tag: 'run to the line' },
  { p: [0.0, 0.35, 103.9], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Wet },
  { p: [0.0, 0.17, 69.2], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.04, 34.6], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
];

// ---------------------------------------------------------------------------
//  Track definitions
// ---------------------------------------------------------------------------

export const CITY_TRACKS: Record<string, TrackDef> = {
  bostonHarbor: {
    id: 'bostonHarbor',
    name: 'Boston Harbor',
    subtitle: 'Brownstones, a tunnel and the cable bridge',
    theme: 'city',
    skyPreset: 'day',
    laps: 3,
    terrainSeed: 16301,
    // ---- NO WATER PLANE, and that was measured, not assumed ----------------
    // A harbour wants water, so this started at -2.2. `.probe-tmp/citywater.ts`
    // says it cannot work here: the `city` terrain theme scales the base field by
    // 0.42, so natural ground on this circuit bottoms out at -1.20 m beyond 260 m
    // and -1.44 m beyond 60 m, while the road-corridor SINK reaches -2.72 m
    // within 30 m of the asphalt. There is no natural basin to fill — at -2.2 the
    // plane covered 0.1 % of the map and its nearest edge was 6.1 m off the
    // tarmac, i.e. a puddle on the verge rather than a harbour, and any level high
    // enough to read would flood the road's own shoulder first.
    //
    // So the harbour front is read from the QUAY instead: the `seaWall` run, the
    // catch fence on the outside, the mast line along the rail, and the bridge.
    // A real basin needs the terrain to be carved for it, which is
    // `Terrain.ts` / `WorldTextures.ts` work and not this file's to do.
    waterLevel: null,
    fogColor: 0xbcd0e0,
    fogDensity: 0.0019,
    road: {
      // Daylight circuit with a cool sky, so unlike the coastal track there is
      // no gold to compound: `worn` asphalt is the lightest recipe and carries a
      // full crack field, which is what a city street wants. Tint held slightly
      // warm-grey so the brick and the granite have something to sit against.
      asphalt: 'worn',
      tint: 0xe8e6e0,
      kerbA: 0xb8352a,
      kerbB: 0xf2efe6,
      line: 0xf6f2e6,
      verge: 0x8f8b84,
      rail: 0xb9c3cc,
      energy: 0x53d8ff,
      racingLine: 0.8,
      ao: 0.95,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: BOSTON_NODES,
    props: [
      // ---- WHICH CITY THIS IS ---------------------------------------------
      // Not a prop: a DECLARATION. `theme: 'city'` routes to `Props.buildCity()`,
      // and until this existed that meant one kit — the same 46 m grey setback
      // tower, the same ring-and-bars neon mast, the same parked cars and the same
      // three cable trams — on Boston, Taipei, Tokyo and Neon Metropolis alike.
      // The critic's verdict was that Boston was *"indistinguishable from Neon
      // Metropolis"*, and the counts agreed: 68 generic towers and 30 neon signs
      // against 18 Boston-specific instances.
      //
      // `districtBrick` selects brick, granite and glass: masonry commercial
      // blocks with limestone quoins and cornices, a minority of dark glass slabs,
      // NO neon signage anywhere and no trams. `Props.buildCity` claims this
      // marker with `takeAuthored` before it emits anything, so it produces no
      // geometry — see CITY_KITS in `Props.ts`, and `.probe-tmp/props.ts` for why
      // the probe treats it as a declaration rather than a missing builder.
      { type: 'districtBrick', t: 0.0, lat: 0 },
      // ---- start / finish -------------------------------------------------
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'grandstand', t: 0.006, lat: -29, scale: 1.15 },
      { type: 'crowdStand', t: 0.022, lat: 27 },
      { type: 'balloonArch', t: 0.048, lat: 0, up: 9 },
      // Downtown behind the stands. `skyscraper` and `towerBlock` are the
      // existing city recipes; the first is folded into `buildCity`'s own
      // InstancedMesh by `takeAuthored`, so it costs no draw call at all.
      { type: 'skyscraper', t: 0.01, lat: 96, step: 0.02, end: 0.11, mirror: true, scale: 1.5 },
      { type: 'towerBlock', t: 0.014, lat: 46, step: 0.016, end: 0.12, mirror: true },
      // THE GLASS TOWER, at the far end of the boulevard: 118 m of dark glass
      // straight down the road you spend the longest looking at.
      { type: 'glassTower', t: 0.116, lat: -78 },
      { type: 'streetLamp', t: 0.02, lat: 17, step: 0.02, end: 0.12, mirror: true },
      { type: 'brakeBoard', t: 0.121, lat: -15 },
      { type: 'tyreStack', t: 0.138, lat: 12.5, step: 0.005, end: 0.166 },
      { type: 'signChevron', t: 0.142, lat: -14.5, step: 0.006, end: 0.172 },
      // ---- the brownstone terrace ----------------------------------------
      // Across-road half-extent 6.3 m against an hw of 9, so lat 22 leaves 6.7 m
      // of clear verge. Two numbers here were measured, not guessed:
      //   * the run STOPS at t=0.278, before the R62 kink at 0.288. A 23 m prop
      //     standing tangentially on a 62 m radius swings its ends ~1.4 m toward
      //     the road; at the old 31 m and lat 20 the worst instance reached 0.7 m
      //     INSIDE the tarmac (`.probe-tmp/crowding.ts`).
      //   * the 23.6 m step matches the 23 m prop, so the terrace is continuous.
      { type: 'brownstoneRow', t: 0.188, lat: 22, step: 0.0145, end: 0.278, mirror: true },
      { type: 'streetLamp', t: 0.19, lat: 16, step: 0.026, end: 0.29 },
      { type: 'planter', t: 0.20, lat: 14, step: 0.016, end: 0.28 },
      { type: 'trafficLight', t: 0.298, lat: 14 },
      // ---- the tunnel -----------------------------------------------------
      { type: 'tunnelPortal', t: 0.319, lat: 0 },
      { type: 'tunnelPortal', t: 0.400, lat: 0, yaw: Math.PI },
      // ---- harbour front --------------------------------------------------
      { type: 'signChevron', t: 0.408, lat: -15, step: 0.006, end: 0.436 },
      { type: 'seaWall', t: 0.446, lat: 20, step: 0.008, end: 0.508 },
      // The existing plain-cloth mast run along the harbour rail. The NATIONAL
      // flag is a different type and stands alone on the State House terrace.
      { type: 'flagPole', t: 0.452, lat: -19, step: 0.013, end: 0.506 },
      { type: 'billboard', t: 0.468, lat: -23, scale: 1.2 },
      { type: 'crowdStand', t: 0.49, lat: 26 },
      // ---- the bridge -----------------------------------------------------
      // Both towers straddle the deck (`lat: 0`, so local +-X is across the
      // road). `bridgearch` is in `CORRIDOR_PROPS`, so nothing pushes it aside.
      { type: 'bridgeArch', t: 0.552, lat: 0 },
      { type: 'bridgeArch', t: 0.598, lat: 0 },
      // NO `bridgePylon` RUN, and that is measured. `.probe-tmp/cityspan.ts`:
      // the recipe hangs its capital AT the anchor and descends 46 m, so at
      // `up: -9` the whole column tops out 9 m BELOW the local ground — because
      // the terrain bake follows an isolated elevated deck (`WorldTextures.bake`
      // only declines to pave ground that a LOWER carriageway also reaches), so
      // there is no void under this deck for a pier to stand in. All nine
      // instances measured 100 % underground. The deck reads as a raised harbour
      // crossing carried by the two obelisk towers instead, and two draw calls
      // and 9 invisible instances go away.
      { type: 'brakeBoard', t: 0.612, lat: -14 },
      { type: 'signChevron', t: 0.620, lat: 14, step: 0.006, end: 0.644 },
      // ---- the dome plaza -------------------------------------------------
      // Across-road half-extent 12.9 m against an hw of 10.5: lat 34 leaves
      // 10.6 m. The flag mast is 1.15 m across and sits at lat -15, on the same
      // side, 3.4 m clear — the plaza in front of the building, which is where a
      // national flag on a government building actually stands.
      { type: 'goldenDome', t: 0.662, lat: -34 },
      { type: 'flagUSA', t: 0.674, lat: -15 },
      { type: 'planter', t: 0.658, lat: 15, step: 0.012, end: 0.70 },
      { type: 'streetLamp', t: 0.66, lat: 16, step: 0.018, end: 0.70, mirror: true },
      { type: 'towerBlock', t: 0.71, lat: 40, step: 0.014, end: 0.78, mirror: true },
      // ---- the green wall -------------------------------------------------
      // Across-road half-extent 4.9 m (the flood towers behind it) against an hw
      // of 10.5. Two of them cover the 42 m corner. lat 29 rather than 26 for the
      // chord reason above: this is a 43 m prop on a 66 m radius, so its ends sit
      // ~3.5 m closer to the road than its centre.
      { type: 'stadiumWall', t: 0.796, lat: 29 },
      { type: 'stadiumWall', t: 0.822, lat: 29 },
      { type: 'crowdStand', t: 0.845, lat: -25, step: 0.018, end: 0.88 },
      { type: 'signChevron', t: 0.79, lat: -15, step: 0.006, end: 0.82 },
      // ---- the run to the line -------------------------------------------
      { type: 'streetLamp', t: 0.935, lat: 17, step: 0.016, end: 0.995, mirror: true },
      { type: 'skyscraper', t: 0.90, lat: 92, step: 0.024, end: 0.99, scale: 1.4 },
      { type: 'crowdStand', t: 0.968, lat: 27 },
    ],
    boostPads: [
      { t: 0.470, lat: -4, width: 7, length: 16 },
      { t: 0.470, lat: 4, width: 7, length: 16 },
      { t: 0.680, lat: 0, width: 9, length: 15 },
      { t: 0.950, lat: 0, width: 9, length: 16 },
    ],
    // Three rows a lap, before the overtaking spots rather than on every
    // straight — the count `TrackDefs` settled on after a playtester reported
    // constant attacks.
    itemRows: [
      { t: 0.225, count: 3, spread: 11 },
      { t: 0.455, count: 5 },
      { t: 0.755, count: 5 },
    ],
    // Off the racing line, and far enough apart that nothing can chain-hit.
    hazards: [
      { kind: 'oil', t: 0.345, lat: -6 },
      { kind: 'snapper', t: 0.688, lat: -13 },
    ],
  },

  taipeiCircuit: {
    id: 'taipeiCircuit',
    name: 'Taipei Circuit',
    subtitle: 'A night market, a 150 m sweeper and the tiered tower',
    theme: 'city',
    skyPreset: 'sunset',
    laps: 3,
    terrainSeed: 41102,
    waterLevel: null,
    fogColor: 0xf0a878,
    fogDensity: 0.0022,
    road: {
      // Dusk key light, so the same rule as the coastal circuit applies: warmth
      // in the albedo compounds with a warm key and a warm env into gold. Tint
      // is held cool-neutral and the kerbs go blue, which is also what keeps the
      // lantern glow reading as the warm thing in frame.
      asphalt: 'clean',
      tint: 0xdfe4ea,
      kerbA: 0x22407a,
      kerbB: 0xf2efe6,
      line: 0xf4f0e4,
      verge: 0x7d7a72,
      rail: 0xa8b2bb,
      energy: 0x53d8ff,
      racingLine: 0.75,
      ao: 1.0,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: TAIPEI_NODES,
    props: [
      // ---- WHICH CITY THIS IS ---------------------------------------------
      // See the note on Boston's `districtBrick`. `districtMidRise` selects dense
      // tiled mid-rise: narrow towers with continuous balcony slabs, roof water
      // tanks and glazed wall tile, plus STACKED SHOPHOUSE SIGNAGE — a column of
      // lit boards bracketed off a mast — instead of the ring-and-bars neon. The
      // authored `neonSign` runs below are claimed by that recipe, so the signage
      // is Taipei's and not Neon Metropolis's. No trams.
      { type: 'districtMidRise', t: 0.0, lat: 0 },
      // ---- start / finish -------------------------------------------------
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'grandstand', t: 0.008, lat: -29, scale: 1.15 },
      { type: 'crowdStand', t: 0.026, lat: 27 },
      { type: 'balloonArch', t: 0.052, lat: 0, up: 9 },
      { type: 'skyscraper', t: 0.012, lat: 88, step: 0.022, end: 0.10, mirror: true, scale: 1.45 },
      { type: 'towerBlock', t: 0.016, lat: 44, step: 0.015, end: 0.105, mirror: true },
      { type: 'streetLamp', t: 0.022, lat: 17, step: 0.018, end: 0.105, mirror: true },
      { type: 'neonSign', t: 0.03, lat: 19, step: 0.014, end: 0.10, mirror: true },
      { type: 'brakeBoard', t: 0.108, lat: 15 },
      { type: 'tyreStack', t: 0.124, lat: -12.5, step: 0.005, end: 0.15 },
      { type: 'signChevron', t: 0.126, lat: 14.5, step: 0.006, end: 0.158 },
      // ---- THE SUPERTALL, on the inside of the long sweeper ---------------
      // 184 m tall and authored once. At lat -96 it is 80 m clear of the road,
      // which is what lets it be the thing on the horizon from most of the lap
      // instead of a wall you drive past.
      { type: 'pagodaTower', t: 0.415, lat: -96 },
      // ---- the night market ----------------------------------------------
      // Across-road half-extent 3.85 m against an hw of 8.5, so lat 20 leaves
      // 7.65 m of clear verge — measured up from 2.9 m, where 32 stalls were
      // filling 9.94 % of the frame. The 12 m step against a 9.3 m bay leaves a
      // gap between stalls, which is what a market looks like anyway.
      { type: 'marketStall', t: 0.168, lat: 20, step: 0.0075, end: 0.262, mirror: true },
      { type: 'trafficLight', t: 0.172, lat: -14 },
      { type: 'holoAd', t: 0.20, lat: 0, up: 10, step: 0.03, end: 0.26 },
      { type: 'neonSign', t: 0.175, lat: 16, step: 0.014, end: 0.26 },
      { type: 'signChevron', t: 0.268, lat: 14, step: 0.006, end: 0.296 },
      // ---- riverside and the sweeper -------------------------------------
      { type: 'streetLamp', t: 0.305, lat: 17, step: 0.017, end: 0.44, mirror: true },
      { type: 'billboard', t: 0.32, lat: 24, scale: 1.25 },
      { type: 'towerBlock', t: 0.31, lat: 46, step: 0.018, end: 0.50, mirror: true },
      { type: 'brakeBoard', t: 0.508, lat: 15 },
      // ---- the memorial plaza --------------------------------------------
      // Across-road half-extent 24.4 m against an hw of 11, so lat 46 leaves
      // 10.6 m. The flag stands at lat 15 on the same side: the plaza in front
      // of the hall, which is exactly where this flag flies.
      { type: 'memorialHall', t: 0.588, lat: 46 },
      { type: 'flagROC', t: 0.578, lat: 15 },
      { type: 'planter', t: 0.566, lat: -15, step: 0.012, end: 0.624 },
      { type: 'crowdStand', t: 0.60, lat: -26 },
      { type: 'signChevron', t: 0.632, lat: 14, step: 0.006, end: 0.656 },
      // ---- the mountain side ----------------------------------------------
      // Backdrop. The prop is 240 m across, and `roadOverhang` judges an anchor
      // on its eight BOX CORNERS, so `lat` has to clear the road by more than the
      // half-extent or the road-surface guard shoves it (measured: at lat 420 one
      // instance was pushed 4.32 m and logged a warning). Beyond 540 every corner
      // is outside the whole 431 x 512 m footprint.
      { type: 'mountainRidge', t: 0.70, lat: 560, scale: 1.15 },
      { type: 'mountainRidge', t: 0.775, lat: 700, scale: 1.35 },
      { type: 'mountainRidge', t: 0.86, lat: 545, scale: 1.0 },
      { type: 'mountainRidge', t: 0.10, lat: -640, scale: 1.25 },
      // 13 m tall and 4 m across: at lat 22 these were among the worst occluders
      // through the one right-hander (`.probe-tmp/sightline.ts`), so they sit back
      // on the bank where a hillside tree belongs.
      { type: 'pine', t: 0.665, lat: 27, step: 0.014, end: 0.775 },
      { type: 'pine', t: 0.79, lat: 28, step: 0.016, end: 0.90 },
      { type: 'signChevron', t: 0.788, lat: -15, step: 0.006, end: 0.83 },
      // ---- the run to the line -------------------------------------------
      { type: 'streetLamp', t: 0.915, lat: 17, step: 0.016, end: 0.995, mirror: true },
      { type: 'neonSign', t: 0.92, lat: 20, step: 0.015, end: 0.99, mirror: true },
      { type: 'crowdStand', t: 0.972, lat: 27 },
    ],
    boostPads: [
      { t: 0.335, lat: 0, width: 10, length: 16 },
      { t: 0.60, lat: -4, width: 7, length: 15 },
      { t: 0.60, lat: 4, width: 7, length: 15 },
      { t: 0.945, lat: 0, width: 9, length: 16 },
    ],
    itemRows: [
      { t: 0.235, count: 3, spread: 10 },
      { t: 0.47, count: 5 },
      { t: 0.885, count: 5 },
    ],
    hazards: [
      { kind: 'oil', t: 0.29, lat: 7 },
      { kind: 'slider', t: 0.735, lat: -9, span: 9, speed: 3 },
    ],
  },

  tokyoNeon: {
    id: 'tokyoNeon',
    name: 'Tokyo Neon',
    subtitle: 'The scramble, the expressway and a torii run',
    theme: 'city',
    skyPreset: 'night',
    laps: 3,
    terrainSeed: 81003,
    waterLevel: null,
    fogColor: 0x121a30,
    fogDensity: 0.0031,
    road: {
      // Wet night city — the same treatment `neonMetropolis` settled on, which
      // is the one place in the game where a near-mirror road is correct: the
      // screens and the neon do their reflecting in it.
      asphalt: 'wet',
      tint: 0xdfe4ee,
      kerbA: 0x2b3450,
      kerbB: 0xd9e6ff,
      line: 0xeaf2ff,
      verge: 0x474e5e,
      rail: 0x8d99ad,
      energy: 0x38e0ff,
      racingLine: 0.7,
      ao: 1.05,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: TOKYO_NODES,
    props: [
      // ---- WHICH CITY THIS IS ---------------------------------------------
      // See the note on Boston's `districtBrick`. `districtNeon` selects dark
      // curtain wall carrying full-height SCREEN PANELS and a lit signage crown,
      // plus both signage recipes: the ring masts and the stacked boards.
      //
      // It is also the answer to the critic's darkness finding. Settled
      // `chase-straight` measured mean luminance 28/255 with 13.8 % of the frame
      // pure black, and hiding the 78 tower bodies made the frame BRIGHTER by
      // 1.28 L — the skyline was a net light sink. Props cannot add real lights,
      // so this kit adds emissive AREA at the scale that matters: two 6 x 17 m
      // screens and a 4-sided signage crown per tower, a 2.6 m shopfront band
      // round every tower base at eye level, and a window-lit fraction driven off
      // the sky preset (0.28 threshold at night against the old fixed 0.42).
      { type: 'districtNeon', t: 0.0, lat: 0 },
      // ---- start / finish, under the expressway ---------------------------
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'grandstand', t: 0.007, lat: -29, scale: 1.15 },
      { type: 'crowdStand', t: 0.024, lat: 27 },
      { type: 'balloonArch', t: 0.05, lat: 0, up: 9 },
      { type: 'skyscraper', t: 0.012, lat: 92, step: 0.021, end: 0.115, mirror: true, scale: 1.5 },
      { type: 'towerBlock', t: 0.016, lat: 45, step: 0.015, end: 0.12, mirror: true },
      { type: 'streetLamp', t: 0.02, lat: 17, step: 0.017, end: 0.12, mirror: true },
      { type: 'neonSign', t: 0.028, lat: 20, step: 0.013, end: 0.115, mirror: true },
      // THE EXPRESSWAY CROSSING OVERHEAD. Authored at lat 0 with `up: 9.6`, so
      // the anchor is the deck and the piers hang 9.6 m down from it to the
      // ground — the `bridgePylon` convention. In `CORRIDOR_PROPS`, so the road
      // guards leave it where it was put.
      { type: 'overpassArch', t: 0.100, lat: 0, up: 9.6 },
      { type: 'overpassArch', t: 0.245, lat: 0, up: 9.6 },
      // THE BROADCAST SPIRE: 196 m, authored once, 200 m off the road at a
      // section that is NOT elevated so it gets re-seated onto real ground.
      { type: 'broadcastSpire', t: 0.215, lat: -204 },
      { type: 'brakeBoard', t: 0.126, lat: -15 },
      { type: 'tyreStack', t: 0.142, lat: 12.5, step: 0.005, end: 0.17 },
      // ---- the scramble crossing -----------------------------------------
      // Across-road half-extent 8.9 m against an hw of 11, so lat 27 leaves
      // 7.1 m — outside the 6 m band the crowding probe counts as near-road,
      // which is the point: the enclosure here comes from the `building` wall
      // style on the section, not from parking a 29 m block on the kerb.
      { type: 'screenTower', t: 0.196, lat: 27, mirror: true },
      { type: 'screenTower', t: 0.246, lat: 27, mirror: true },
      { type: 'holoAd', t: 0.20, lat: 0, up: 12, step: 0.026, end: 0.27 },
      { type: 'trafficLight', t: 0.19, lat: 15 },
      { type: 'trafficLight', t: 0.262, lat: -15 },
      { type: 'billboard', t: 0.286, lat: -24, scale: 1.3 },
      { type: 'signChevron', t: 0.28, lat: 14, step: 0.006, end: 0.306 },
      // ---- the elevated expressway ---------------------------------------
      // No `bridgePylon` run here either — see the note on Boston's bridge. All
      // 20 instances measured 100 % below the stamped ground.
      // 25.4 m of beam yoke on a 3 m mast: `neonMetropolis` learned that this one
      // has to sit at |lat| >= 19 or the far arm hangs over the tarmac. -25 here,
      // because the deck it flanks is banked to 10 degrees.
      { type: 'monorailPylon', t: 0.42, lat: -25, step: 0.014, end: 0.50 },
      { type: 'skyscraper', t: 0.40, lat: 84, step: 0.022, end: 0.56, mirror: true, scale: 1.35 },
      { type: 'brakeBoard', t: 0.596, lat: -14 },
      { type: 'signChevron', t: 0.632, lat: 14, step: 0.006, end: 0.664 },
      // ---- the shrine district -------------------------------------------
      // The torii face the road (yaw 0), so their 12.1 m width runs ALONG it and
      // the across-road half-extent is 0.72 m. At lat 18 that is 7.8 m of clear
      // verge, and the 13.8 m step spaces the gates instead of overlapping them.
      { type: 'torii', t: 0.682, lat: 18, step: 0.009, end: 0.772 },
      // The far-side row is kept to the STRAIGHT part of the approach and pushed
      // to -25: on the inside of the R42 left a 12 m gate at -20 was hiding a
      // quarter of the road ahead (`.probe-tmp/sightline.ts`, t=0.715).
      { type: 'torii', t: 0.686, lat: -25, step: 0.012, end: 0.722 },
      { type: 'streetLamp', t: 0.68, lat: 16, step: 0.02, end: 0.77 },
      { type: 'planter', t: 0.695, lat: -15, step: 0.013, end: 0.755 },
      // ---- the lattice tower ---------------------------------------------
      // Across-road half-extent 13.1 m against an hw of 10, so lat -46 leaves
      // 22.9 m: it stands in its own plaza, and the national flag stands in
      // that plaza too, at lat -15 on the same side.
      { type: 'latticeTower', t: 0.796, lat: -46 },
      { type: 'flagJapan', t: 0.812, lat: -15 },
      { type: 'crowdStand', t: 0.84, lat: 26, step: 0.018, end: 0.875 },
      { type: 'towerBlock', t: 0.79, lat: 42, step: 0.015, end: 0.87, mirror: true },
      // ---- the run to the line -------------------------------------------
      { type: 'streetLamp', t: 0.92, lat: 17, step: 0.016, end: 0.995, mirror: true },
      { type: 'neonSign', t: 0.925, lat: 20, step: 0.014, end: 0.99, mirror: true },
      { type: 'crowdStand', t: 0.97, lat: -27 },
    ],
    boostPads: [
      { t: 0.225, lat: -4, width: 7, length: 16 },
      { t: 0.225, lat: 4, width: 7, length: 16 },
      { t: 0.475, lat: 0, width: 10, length: 16 },
      { t: 0.955, lat: 0, width: 9, length: 16 },
    ],
    itemRows: [
      { t: 0.245, count: 5 },
      { t: 0.49, count: 3, spread: 12 },
      { t: 0.94, count: 5 },
    ],
    hazards: [
      { kind: 'oil', t: 0.30, lat: -7 },
      { kind: 'slider', t: 0.70, lat: 8, span: 9, speed: 3 },
    ],
  },
};

/** Menu / cup order for the city series, appended after the original three. */
export const CITY_TRACK_ORDER: readonly string[] = [
  'bostonHarbor', 'taipeiCircuit', 'tokyoNeon',
];
