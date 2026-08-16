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
//  river — and the tiered supertall stands ACROSS it, 320 m out, which is the
//  distance at which the whole 187 m of it fits in frame (see the prop note) —
//  then the signature corner: a 150 m-radius banked left, 123 m long. A banked
//  left onto the MEMORIAL PLAZA, a tight left out of it, the lone right, and
//  then a 154-degree double-apex left with the mountains behind it.
//
//  The national flag flies in a row down both sides of the start/finish
//  straight and again on the memorial plaza; see the flag note in the Boston
//  props list, which explains the scheme once for all three circuits.
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

// ===========================================================================
//  7. HONG KONG HARBOUR  —  1.59 km, blue hour on the harbour
// ===========================================================================
//
//  Anticlockwise, so the OUTSIDE of every corner — and the harbour with it — is
//  on the driver's right for the whole lap. 273 m of Victoria Harbour promenade
//  through the start/finish line, the towers of the far shore standing across
//  the water on the right, then the hardest braking here (R58, 66 degrees) into
//  the NEON CANYON: 17 m between shophouse faces with lit boxes cantilevered out
//  over the street from both sides. Out of the canyon onto the TRAM STREET, past
//  a block wrapped head to foot in bamboo scaffolding, and then the climb — a
//  65 degree left, 24 m, and the ONE right-hander on the lap, an R46 switchback,
//  taken 11 m higher than the one before it. Over the ridge at 16.5 m with the
//  mountain on the skyline, down the R150 sweeper into Central, and a 124 m left
//  under the supertall onto the harbour front and the run to the line.
//
//  Elevation: 0 m at the line, 16.5 m on the ridge. Max grade 4.14 %.
//
//  THERE IS NO GLOBAL WATER PLANE, for the reason measured on `bostonHarbor`
//  below: the `city` terrain theme has no basin to fill. The harbour is a PROP —
//  see `harbourWater` in `Props.ts` — seated on the heightfield with its own
//  7 m apron, on the reflective metal material rather than painted blue.
const HONG_KONG_NODES: SplineNodeSpec[] = [
  // ---- H1 the Victoria Harbour promenade — the harbour is on the RIGHT
  //      for the whole lap (an anticlockwise circuit puts the outside there).
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, -0.05, -29.5], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', flags: TF.Grid },
  { p: [0.0, -0.01, -59.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', flags: TF.Grid },
  { p: [0.0, 0.07, -88.5], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', flags: TF.Grid },
  { p: [0.0, 0.18, -118.1], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [0.0, 0.31, -147.6], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [0.0, 0.49, -177.1], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [0.0, 0.72, -206.6], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  // ---- H2 Turn 1 — the hardest braking on the lap, R58
  { p: [-1.5, 0.82, -219.8], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'TURN 1' },
  { p: [-6.0, 0.93, -232.3], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-13.2, 1.03, -243.4], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-22.7, 1.14, -252.6], hw: 9.5, bank: -8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- H3 the neon canyon — narrowest road here, signs overhead
  { p: [-34.1, 1.24, -259.4], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'NEON CANYON' },
  { p: [-57.4, 1.44, -270.0], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-80.7, 1.66, -280.6], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-104.1, 1.90, -291.2], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-127.4, 2.17, -301.8], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-142.6, 2.36, -307.1], hw: 9, bank: -6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'canyon kink' },
  { p: [-158.6, 2.57, -309.7], hw: 9, bank: -6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-174.7, 2.83, -309.5], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-206.8, 3.47, -306.2], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [-238.9, 4.27, -303.0], hw: 8.5, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  // ---- H4 the tram street, and the scaffolded building
  { p: [-252.6, 4.64, -300.3], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', tag: 'tram street' },
  { p: [-265.4, 5.03, -295.1], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [-277.1, 5.45, -287.5], hw: 9.5, bank: -7, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [-287.2, 5.90, -278.0], hw: 10, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [-300.8, 6.63, -262.4], hw: 10, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  // ---- H5 the ladder-street switchbacks: a 65 deg left, 24 m, then
  //      the only right-hander on the lap. The road climbs 11 m through them.
  { p: [-314.3, 7.45, -246.9], hw: 9.5, bank: -9, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building', tag: 'LADDER STREET' },
  { p: [-321.0, 7.93, -237.2], hw: 9.5, bank: -9, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },
  { p: [-325.3, 8.42, -226.3], hw: 9.5, bank: -9, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },
  { p: [-327.1, 8.90, -214.7], hw: 9.5, bank: -9, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },
  { p: [-326.2, 9.37, -203.0], hw: 9.5, bank: -9, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'building' },
  { p: [-322.7, 9.82, -191.8], hw: 9.5, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-313.2, 10.72, -170.1], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail', tag: 'THE RIGHT' },
  { p: [-310.3, 11.08, -161.0], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-309.3, 11.45, -151.6], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-310.3, 11.82, -142.2], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-313.2, 12.19, -133.1], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-317.9, 12.57, -124.9], hw: 10, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-324.1, 12.94, -117.7], hw: 10.5, bank: 2, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete', tag: 'mid-levels climb' },
  { p: [-342.4, 13.88, -100.9], hw: 10.5, bank: 2, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-360.8, 14.70, -84.0], hw: 10.5, bank: 2, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-379.1, 15.37, -67.1], hw: 10.5, bank: 2, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-388.5, 15.69, -56.2], hw: 9.5, bank: -8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail', tag: 'ridge left' },
  { p: [-395.1, 15.96, -43.4], hw: 9.5, bank: -8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-398.5, 16.19, -29.4], hw: 9.5, bank: -8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  { p: [-398.7, 16.36, -15.0], hw: 9.5, bank: -8, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'guardrail' },
  // ---- H6 the ridge — the high point, 17 m, with Lion Rock beyond
  { p: [-396.0, 16.48, 10.7], hw: 11, shL: 4.5, shR: 4.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete', tag: 'THE RIDGE' },
  { p: [-393.2, 16.34, 36.4], hw: 11, shL: 4.5, shR: 4.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  { p: [-390.5, 15.96, 62.0], hw: 11, shL: 4.5, shR: 4.5, shoulderSurface: S.Grass, wallL: 'guardrail', wallR: 'concrete' },
  // ---- H7 the R150 descending sweeper into Central, 82 m of corner
  { p: [-385.1, 15.36, 88.9], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail', tag: 'CENTRAL DESCENT' },
  { p: [-374.9, 14.59, 114.3], hw: 12, bank: -10, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'guardrail' },
  { p: [-360.3, 13.65, 137.5], hw: 11.5, bank: -2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'descent' },
  { p: [-344.8, 12.66, 157.6], hw: 11.5, bank: -2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-329.3, 11.64, 177.8], hw: 11.5, bank: -2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-313.8, 10.67, 198.0], hw: 11.5, bank: -2, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-303.8, 10.14, 208.7], hw: 10.5, bank: -8, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'central left' },
  { p: [-291.9, 9.62, 217.5], hw: 10.5, bank: -8, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-278.6, 9.10, 223.8], hw: 10.5, bank: -8, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-256.5, 8.26, 231.8], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-234.4, 7.42, 239.8], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- H8 the long left under the supertall, 124 m of corner
  { p: [-212.3, 6.63, 247.9], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'SUPERTALL SWEEP' },
  { p: [-188.2, 5.89, 253.5], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-163.5, 5.24, 253.3], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-139.5, 4.64, 247.2], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [-117.6, 4.05, 235.7], hw: 11.5, bank: -10, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- H9 back onto the harbour front — the overtaking spot
  { p: [-99.1, 3.50, 219.3], hw: 12, shL: 5, shR: 6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'harbour entry' },
  { p: [-81.3, 2.95, 199.3], hw: 12, shL: 5, shR: 6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-63.5, 2.46, 179.3], hw: 12, shL: 5, shR: 6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-45.7, 1.98, 159.3], hw: 12, shL: 5, shR: 6, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-27.8, 1.54, 139.3], hw: 11.5, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'final sweeper' },
  { p: [-12.7, 1.14, 117.4], hw: 11.5, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [-3.2, 0.79, 92.5], hw: 11.5, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [0.0, 0.49, 66.1], hw: 11.5, bank: -9, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [0.0, 0.19, 33.1], hw: 12.5, bank: -2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'run to the line' },
];

// ===========================================================================
//  8. NEW YORK CIRCUIT  —  1.58 km, clear midday
// ===========================================================================
//
//  Clockwise, and deliberately the BRIGHT one: the series now reads Boston day,
//  Taipei sunset, Tokyo night, Hong Kong blue hour, New York midday.
//
//  288 m of avenue canyon through the line — towers both sides, cabs at the
//  kerb, steam off a manhole — into the latest braking on the lap (R50, 66
//  degrees) and a hard right onto the cross street: 18 m between brownstone
//  stoops and tenement fire escapes. Right again into the park, which is the
//  INFIELD, so the tree line and the boating lake read across the inside of
//  three corners; the R44 around the lake is the tightest thing here. Then the
//  only left on the circuit, out of the park and up the ramp onto the EAST RIVER
//  CROSSING — 210 m of deck 9 m in the air, carried on two granite towers with
//  pointed arches and a cable web. Down the off-ramp into the downtown canyon,
//  a banked R86 under the stepped steel crown, and the run to the line.
//
//  Elevation: -1.0 m at the cross street, 8.7 m on the bridge deck. Max grade
//  3.92 %. No gaps and no anti-gravity — see the note at the top of this file.
const NEW_YORK_NODES: SplineNodeSpec[] = [
  // ---- N1 the avenue — 288 m of canyon through the line, towers both sides
  { p: [0.0, 0.00, 0.0], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid, tag: 'S/F line' },
  { p: [0.0, -0.00, -30.1], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.03, -60.2], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.06, -90.2], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', flags: TF.Grid },
  { p: [0.0, 0.03, -120.3], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, -0.11, -150.4], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, -0.37, -180.5], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, -0.66, -210.6], hw: 12.5, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- N2 Turn 1 — R50, the latest braking on the lap
  { p: [1.3, -0.76, -222.0], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'TURN 1' },
  { p: [5.2, -0.84, -232.8], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [11.5, -0.89, -242.4], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [19.7, -0.93, -250.4], hw: 9.5, bank: 8, shL: 2.5, shR: 2.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- N3 the cross street: brownstone stoops both sides, 18 m wide
  { p: [29.6, -0.95, -256.2], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'BROWNSTONES' },
  { p: [59.5, -0.91, -269.6], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [89.4, -0.79, -282.9], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [119.3, -0.63, -296.3], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building', tag: 'brownstone kink' },
  { p: [139.8, -0.47, -302.8], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [161.3, -0.23, -304.6], hw: 9.5, bank: 6, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [182.6, 0.09, -301.5], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [205.1, 0.50, -295.7], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [227.6, 0.90, -289.8], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  { p: [250.1, 1.26, -284.0], hw: 9, shL: 2, shR: 2, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'building' },
  // ---- N4 into the park. The park is the INFIELD, on the driver's right,
  //      so the tree line and the lake read across the inside of three corners.
  { p: [262.3, 1.45, -279.4], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence', tag: 'park entry' },
  { p: [273.3, 1.64, -272.4], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [282.5, 1.83, -263.2], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'fence' },
  { p: [289.7, 2.03, -252.3], hw: 11, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence', tag: 'THE PARK' },
  { p: [302.3, 2.48, -227.7], hw: 11, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [314.8, 2.91, -203.2], hw: 11, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [327.4, 3.25, -178.7], hw: 11, shL: 5, shR: 5, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  // ---- N5 R44 around the lake, the tightest corner on the circuit
  { p: [331.1, 3.36, -168.7], hw: 9.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence', tag: 'LAKE RIGHT' },
  { p: [332.2, 3.45, -158.1], hw: 9.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [330.8, 3.54, -147.5], hw: 9.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [326.9, 3.63, -137.6], hw: 9.5, bank: 9, shL: 3, shR: 3, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [316.3, 3.83, -118.1], hw: 10, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  { p: [305.7, 4.10, -98.6], hw: 10, shL: 4, shR: 4, shoulderSurface: S.Grass, wallL: 'concrete', wallR: 'fence' },
  // ---- N6 the one left-hander, out of the park onto the river road
  { p: [301.8, 4.26, -89.0], hw: 9.5, bank: -9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'THE LEFT' },
  { p: [300.2, 4.45, -78.7], hw: 9.5, bank: -9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [300.9, 4.67, -68.4], hw: 9.5, bank: -9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [303.9, 4.90, -58.4], hw: 9.5, bank: -9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [309.0, 5.16, -49.4], hw: 9.5, bank: -9, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- N7 the East River crossing — 210 m of deck, 9 m up, on two masonry
  //      towers. Shoulders cut back to a kerb and a barrier.
  { p: [316.1, 5.44, -41.8], hw: 11, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', tag: 'bridge ramp' },
  { p: [331.8, 6.01, -28.3], hw: 11, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [347.4, 6.62, -14.8], hw: 11, bank: 3, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [365.2, 7.39, 4.6], hw: 11, bank: 5, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'THE BRIDGE' },
  { p: [377.9, 8.07, 27.6], hw: 11, bank: 5, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [385.0, 8.52, 52.9], hw: 11, bank: 5, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [385.9, 8.66, 79.2], hw: 11, bank: 5, shL: 1.2, shR: 1.2, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [380.7, 8.46, 105.0], hw: 10.5, bank: 2, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge, tag: 'off the deck' },
  { p: [375.0, 8.12, 122.2], hw: 10.5, bank: 2, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete', flags: TF.Bridge },
  { p: [369.4, 7.64, 139.4], hw: 10.5, bank: 2, shL: 1.5, shR: 1.5, shoulderSurface: S.Metal, wallL: 'concrete', wallR: 'concrete' },
  { p: [361.4, 6.98, 156.9], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'off-ramp right' },
  { p: [349.6, 6.24, 172.2], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [334.8, 5.49, 184.5], hw: 10, bank: 8, shL: 3, shR: 3, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- N8 the downtown canyon under the steel crown
  { p: [312.1, 4.55, 199.4], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', tag: 'DOWNTOWN' },
  { p: [289.4, 3.78, 214.2], hw: 10.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [266.7, 3.16, 229.1], hw: 11, bank: 5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete', tag: 'downtown kink' },
  { p: [249.3, 2.79, 238.5], hw: 11, bank: 5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [230.7, 2.50, 244.8], hw: 11, bank: 5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'building', wallR: 'concrete' },
  { p: [204.0, 2.19, 251.5], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [177.3, 1.94, 258.2], hw: 11, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  // ---- N9 the banked right under the stepped crown, 100 m of corner
  { p: [157.4, 1.78, 260.7], hw: 10.5, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'CROWN SWEEP' },
  { p: [137.4, 1.64, 258.6], hw: 10.5, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [118.5, 1.51, 251.9], hw: 10.5, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [101.6, 1.41, 241.0], hw: 10.5, bank: 9, shL: 3.5, shR: 3.5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [87.7, 1.30, 226.5], hw: 11.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'spire straight' },
  { p: [70.7, 1.16, 203.9], hw: 11.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [53.7, 1.01, 181.3], hw: 11.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [36.7, 0.85, 158.8], hw: 11.5, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [19.7, 0.69, 136.2], hw: 11.5, bank: 8, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'final sweeper' },
  { p: [8.9, 0.55, 118.1], hw: 11.5, bank: 8, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [2.3, 0.40, 98.1], hw: 11.5, bank: 8, shL: 4, shR: 4, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.27, 77.2], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete', tag: 'run to the line' },
  { p: [0.0, 0.13, 51.5], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
  { p: [0.0, 0.05, 25.7], hw: 12.5, bank: 2, shL: 5, shR: 5, shoulderSurface: S.OffRoad, wallL: 'concrete', wallR: 'concrete' },
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
    // Explicit, because `theme: 'city'` defaults to RAIN and this is a midday
    // harbour. Rain also triggers `Weather.applyWetRoad(true)`, which cuts road
    // roughness to 0.28x and puts droplets on the lens — the owner's "difficult
    // to view" complaint. None of the city series races in the wet.
    weather: 'clear',
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
      // ---- THE NATIONAL FLAG, and where a circuit actually flies one -------
      //
      // This is the third attempt at the owner's *"the three city series tracks
      // still lack naturally incorporated national flags"*, and the first two
      // both answered a question that was not asked. Round one added the type;
      // round two rebuilt its cloth so it ripples (36 triangles, 25 distinct
      // `aFlap` levels). Both are true and neither is the complaint:
      // `.probe-tmp/citymeta.ts` has asserted "one correct flag, on its own
      // atlas cell" on each circuit for two rounds while the owner kept saying
      // there were none. Measured, that is not surprising — ONE mast, on ONE
      // plaza, at ONE point of the lap:
      //
      //     masts                              1
      //     flag-stations per lap station    0.19-0.27   (Taipei / Tokyo)
      //
      // i.e. for three quarters of every lap there is no flag anywhere in frame.
      // "Present" and "naturally incorporated" are different claims and only the
      // first was ever being tested.
      //
      // So all three circuits now fly the same three-part scheme, which is what
      // a real street circuit does:
      //
      //   1. A ROW DOWN BOTH SIDES OF THE START/FINISH STRAIGHT. Seven masts a
      //      side, in front of the grandstand and the crowd stand, at the one
      //      place every car passes at the start of every lap. This is the
      //      unmissable one.
      //   2. A CEREMONIAL PAIR ON THE CIVIC BUILDING'S PLAZA — the State House
      //      here, the memorial hall on Taipei, the tower plaza on Tokyo. One at
      //      `scale: 1.7` (a 16 m mast with a 4.6 x 3.1 m flag) so the plaza has
      //      a hierarchy rather than two identical poles.
      //   3. ONE AT THE MID-LAP STAND, so the far half of the lap is not bare.
      //
      // `lat: 21` puts them outboard of the street lamps at 17 and, on the two
      // signed circuits, of the signage at 20 — the row stands behind the street
      // furniture and in front of the stands, which is where flagpoles go.
      //
      // COST: none in draw calls. Every instance of one authored type shares a
      // single InstancedMesh per pass, so 17 masts are the same two draws as 1,
      // and 244 triangles each.
      { type: 'flagUSA', t: 0.006, lat: 21, step: 0.009, end: 0.060, mirror: true },
      { type: 'flagUSA', t: 0.490, lat: 22 },
      // `up: 0`, not 9. The recipe's two ballast blocks are built at local
      // y = 0..0.6, so the arch's origin IS ground level — `up: 9` lifted the whole
      // 22 m span nine metres into the air and left its feet 8.45 m above the
      // tarmac. Measured on all four circuits that carry one: 8.44-8.45 m of clear
      // air under the ballast. This is the owner's "balloons that appear
      // unnaturally suspended in the air", and it was authored, not computed.
      { type: 'balloonArch', t: 0.048, lat: 0, up: 0 },
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
      { type: 'flagUSA', t: 0.674, lat: -15, scale: 1.7 },
      { type: 'flagUSA', t: 0.686, lat: -15 },
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
      // OIL SLICKS REMOVED, at the owner's request, twice: "remove the black
      // mist-like obstacles in the middle of the tracks, as they negatively
      // impact the gameplay experience."
      //
      // `makeOil` paints a 6.2 m disc at `rgba(10,10,14,0.95)` — near-black at
      // 95 % opacity — lying flat on the road with `depthWrite: false`. On dark
      // asphalt that does not read as an object you can dodge; it reads as fog,
      // which is exactly the word the owner reached for. It also carried
      // `stun: 0.85` with `kick: 0`, so it spun you with no visual warning.
      //
      // The `'oil'` hazard KIND is left intact in `src/items/Hazards.ts`. If it
      // comes back it needs art that reads as a hazard at 25 m — a bright rim, a
      // raised lip, warning chevrons on the road — not a darker patch of dark.
      { kind: 'snapper', t: 0.688, lat: -13 },
    ],
  },

  taipeiCircuit: {
    id: 'taipeiCircuit',
    name: 'Taipei Circuit',
    subtitle: 'A night market, a 150 m sweeper and the tiered tower',
    theme: 'city',
    skyPreset: 'sunset',
    weather: 'clear',
    laps: 3,
    terrainSeed: 41102,
    waterLevel: null,
    // ---- THIS FIELD IS INERT, AND THAT IS THE POINT ------------------------
    // `fogColor` / `fogDensity` on a `TrackDef` reach exactly one reader,
    // `Track.getAtmosphere()`, and `.probe-tmp/palette.ts` greps the whole of
    // `src/` for that name: ONE occurrence, the definition. Nothing calls it.
    // The fog a frame actually renders is `SKY_PRESETS[skyPreset]`, pushed by
    // `Lighting.setPreset` into `scene.fog` and `worldFogUniforms`.
    //
    // So the old value here — #f0a878, h 24 deg at 80 % saturation, a pure sand
    // apricot — was the obvious suspect for the owner's *"desert-like feeling"*
    // and was never on screen at all. The real culprit was `sunset`'s own
    // `fogColor` #8a5a4a (h 15 deg), which is where the fix went.
    //
    // Left authored rather than deleted, because the field is on the shared
    // `TrackDef` contract and a circuit that omits it would not compile. It now
    // MATCHES the live sunset preset, so if anyone ever wires `getAtmosphere()`
    // up, Taipei does not silently snap back to a sand haze. Density is the one
    // number that is deliberately not the preset's: 0.0016 against 0.00105 is
    // the extra humidity of a subtropical basin, and it is what this circuit
    // would ask for if the field were live.
    fogColor: 0x5b6878,
    fogDensity: 0.0016,
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
      // The flag row. See the scheme note in Boston's props list.
      { type: 'flagROC', t: 0.008, lat: 21, step: 0.009, end: 0.062, mirror: true },
      { type: 'balloonArch', t: 0.052, lat: 0, up: 0 },
      { type: 'skyscraper', t: 0.012, lat: 88, step: 0.022, end: 0.10, mirror: true, scale: 1.45 },
      { type: 'towerBlock', t: 0.016, lat: 44, step: 0.015, end: 0.105, mirror: true },
      { type: 'streetLamp', t: 0.022, lat: 17, step: 0.018, end: 0.105, mirror: true },
      { type: 'neonSign', t: 0.03, lat: 19, step: 0.014, end: 0.10, mirror: true },
      { type: 'brakeBoard', t: 0.108, lat: 15 },
      { type: 'tyreStack', t: 0.124, lat: -12.5, step: 0.005, end: 0.15 },
      { type: 'signChevron', t: 0.126, lat: 14.5, step: 0.006, end: 0.158 },
      // ---- THE SUPERTALL, ACROSS THE RIVER --------------------------------
      // Owner: *"Taipei 101 is too close to the track, leaving no chance to
      // appreciate it."* It was at `t: 0.415, lat: -96`, standing in the infield
      // on the inside of the sweeper, and the note here claimed 80 m of clearance
      // "is what lets it be the thing on the horizon". Measured, that is exactly
      // backwards. `.probe-tmp/landmark.ts` walks the lap at the real chase pose
      // and FOV and asks whether the whole tower is inside the frustum:
      //
      //     whole%  0.0     — not once, from any of 267 stations in a full lap
      //     subV    69.6 deg at 106 m, p50 46.9 deg over every station it is
      //                       visible from; the vertical FOV is 79.75 deg and
      //                       the eye looks at the horizon, so only the upper
      //                       39.9 deg of it is above the eyeline. A 187 m tower
      //                       needs 222 m of distance before its top re-enters
      //                       the frame. At 76 m it never can.
      //     vis%    24.3    — and it was only in frame for a quarter of the lap.
      //
      // A previous round measured the same prop "filling 92.6 % of screen height
      // at 208 m" and recorded that as a success. Screen fill is the defect here,
      // not the achievement.
      //
      // `.probe-tmp/lmscout.ts` searched the whole (t, lat) authoring space for
      // the placement that maximises "seen whole". The answer is across the river
      // on the OUTSIDE of the riverside straight: t 0.33, lat 340, world
      // (-481, -526) — 320 m from the nearest point of the racing line, clear of
      // all four `mountainRidge` cones (nearest 390 m) and outside the circuit's
      // own 431 x 512 m footprint, so no road guard can touch it. It reads down
      // the length of the riverside run and stands over the whole far half of the
      // lap. Re-measured after the move and reported.
      { type: 'pagodaTower', t: 0.33, lat: 340 },
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
      { type: 'flagROC', t: 0.578, lat: 15, scale: 1.7 },
      { type: 'flagROC', t: 0.590, lat: 15 },
      { type: 'flagROC', t: 0.604, lat: -22 },
      { type: 'planter', t: 0.566, lat: -15, step: 0.012, end: 0.624 },
      { type: 'crowdStand', t: 0.60, lat: -26 },
      { type: 'signChevron', t: 0.632, lat: 14, step: 0.006, end: 0.656 },
      // ---- the mountain side ----------------------------------------------
      // FOUR `mountainRidge` CONES REMOVED at the owner's request: "there are many
      // strange pyramid structures in the background that need to be removed", and
      // separately "care must be taken to avoid a desert-like feeling".
      //
      // They were the backdrop for this side of the lap — t 0.70/0.775/0.86 at lat
      // 545-700 and one at t 0.10, lat -640. Taipei genuinely sits in a basin ringed
      // by mountains, so the instinct was sound, but a low-poly cone at 390 m reads
      // as a dune rather than a peak, and four of them in a sunset palette is
      // exactly the desert the owner does not want.
      //
      // The horizon does not go empty: the ring landform is `Mountains`, a separate
      // Environment mesh built from the terrain field, not these props. These were
      // additional cones standing in front of it.
      //
      // They were also the props behind Taipei's 153 m prop re-seat correction —
      // `lat: 700` applied along a BANKED binormal buys 700 * sin(13.5 deg) = 164 m
      // of spurious altitude, which the re-seater then had to undo. Removing them
      // retires that whole class of warning on this circuit.
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
      { kind: 'slider', t: 0.735, lat: -9, span: 9, speed: 3 },
    ],
  },

  tokyoNeon: {
    id: 'tokyoNeon',
    name: 'Tokyo Neon',
    subtitle: 'The scramble, the expressway and a torii run',
    theme: 'city',
    skyPreset: 'night',
    weather: 'clear',
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
      // The flag row. See the scheme note in Boston's props list. It stops at
      // t=0.060, well short of the `TF.Dark` run under the expressway deck at
      // t=0.09 — a flag in the dark under a deck is a flag nobody sees.
      { type: 'flagJapan', t: 0.006, lat: 21, step: 0.009, end: 0.060, mirror: true },
      { type: 'balloonArch', t: 0.05, lat: 0, up: 0 },
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
      { type: 'flagJapan', t: 0.812, lat: -15, scale: 1.7 },
      { type: 'flagJapan', t: 0.824, lat: -15 },
      { type: 'flagJapan', t: 0.848, lat: 22 },
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
      { kind: 'slider', t: 0.70, lat: 8, span: 9, speed: 3 },
    ],
  },

  hongKongHarbour: {
    id: 'hongKongHarbour',
    name: 'Hong Kong Harbour',
    subtitle: 'A neon canyon, a bamboo cage and the ladder streets',
    theme: 'city',
    // ---- WHY `night` AND NOT SOMETHING CALLED "BLUE HOUR" ------------------
    // There are exactly five presets and `SkyPresetName` is a closed union:
    // day, sunset, night, storm, volcanic (`src/world/Sky.ts:22`). Nothing in
    // the game is authored for the hour between them, so the choice is between
    // `sunset` — sunElevation +4.5, haze #ff9a5e, i.e. golden hour — and
    // `night`, whose haze is #121b30 and whose `cityGlow` is 1.0. Blue hour is
    // a deep blue sky with the city's own lights carrying the frame, so this is
    // `night`, and the separation from Tokyo Neon is made where it can actually
    // be made: dry road (`asphalt: 'clean'` against Tokyo's near-mirror `wet`),
    // a cooler kerb, a water surface in frame, and a completely different
    // district kit (`districtPodium` — see `CITY_KITS.hongkong`).
    skyPreset: 'night',
    // Explicit, because `theme: 'city'` defaults to RAIN. None of the city
    // series races in the wet; see the note on `bostonHarbor.weather`.
    weather: 'clear',
    laps: 3,
    terrainSeed: 52807,
    // See the section header: the harbour is a prop, not a plane.
    waterLevel: null,
    // NOT dead, whatever a grep for `getAtmosphere` suggests: `Catalogue.ts`
    // reads `def.fogColor` as `themeB`, the second stop of the course card's
    // gradient, so this value is on screen in the menu even though nothing
    // pushes it into `scene.fog`. Matched to the live `night` preset's own
    // #141d33 so the card and the circuit agree.
    fogColor: 0x141d33,
    fogDensity: 0.0026,
    road: {
      // Dry. Tokyo owns the wet-mirror look on this series and a second circuit
      // doing it would be the "indistinguishable from Neon Metropolis" finding
      // all over again. `clean` asphalt with a cool tint keeps the road reading
      // as a surface while the harbour does the reflecting.
      asphalt: 'clean',
      tint: 0xdae0e8,
      kerbA: 0xc4302a,
      kerbB: 0xf2efe6,
      line: 0xf0eee2,
      verge: 0x585d63,
      rail: 0x9aa4ad,
      energy: 0x46d6ff,
      racingLine: 0.72,
      ao: 1.0,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: HONG_KONG_NODES,
    props: [
      // ---- WHICH CITY THIS IS ---------------------------------------------
      // See the note on Boston's `districtBrick`. `districtPodium` selects the
      // podium-and-tower type — a banded retail/car-park podium out to the lot
      // line with a much slimmer residential shaft on top — plus stacked
      // shophouse signage and red taxis. No ring neon and no trams: the
      // cantilevered boxes and the double-deck trams here are authored recipes,
      // so they land where the art direction wants them rather than scattered.
      { type: 'districtPodium', t: 0.0, lat: 0 },
      // ---- start / finish, on the promenade -------------------------------
      // Everything with seating goes on the LEFT. On an anticlockwise lap the
      // driver's right is the outside of every corner, and here that is the
      // water.
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'grandstand', t: 0.007, lat: -29, scale: 1.15 },
      { type: 'crowdStand', t: 0.026, lat: -27 },
      // The flag row, three-part scheme: see the long note in Boston's props.
      { type: 'flagHK', t: 0.006, lat: 21, step: 0.009, end: 0.060, mirror: true },
      { type: 'balloonArch', t: 0.050, lat: 0, up: 0 },
      { type: 'skyscraper', t: 0.012, lat: -92, step: 0.021, end: 0.118, scale: 1.5 },
      { type: 'towerBlock', t: 0.016, lat: -45, step: 0.015, end: 0.120 },
      { type: 'streetLamp', t: 0.020, lat: 17, step: 0.017, end: 0.120, mirror: true },
      // ---- THE HARBOUR ------------------------------------------------------
      // The water plate is 300 x 210 m and its across-road half-extent is 105 m,
      // so at lat 132 its near edge sits at lat 27 — 8 m outside the 19.05 m
      // corridor, i.e. just beyond the sea wall — and its far edge at lat 237.
      // `up: -1.0` biases it BELOW the local ground on purpose: where the bank
      // rises the terrain covers the seam, and where it falls the plate's own
      // 7 m apron does. Measured in the report.
      { type: 'harbourWater', t: 0.020, lat: 132, up: -1.0 },
      { type: 'seaWall', t: 0.010, lat: 20, step: 0.008, end: 0.112 },
      { type: 'flagPole', t: 0.018, lat: 22, step: 0.013, end: 0.072 },
      // A junk under sail, moored off the promenade. It stands on the water
      // plate: both are seated on the same heightfield sample, so the hull is on
      // the surface by construction rather than by a hand-tuned `up`.
      { type: 'junk', t: 0.048, lat: 64, yaw: 0.4 },
      { type: 'junk', t: 0.088, lat: 112, yaw: -0.9, scale: 0.85 },
      // ---- THE TWO LANDMARKS, ACROSS THE WATER ------------------------------
      // Read the Taipei supertall note before moving either. A tower needs
      // roughly (its height / tan(half the vertical FOV above the eyeline)) of
      // distance before its top is in frame at all: 248 m wants ~290 m and
      // 188 m wants ~220 m. Both are therefore on the FAR SHORE, beyond the
      // water plate's own far edge at lat 237, where they read down the length
      // of the promenade and again from the ridge. Re-measured in the report.
      { type: 'harbourSupertall', t: 0.052, lat: 330 },
      { type: 'bankOfChina', t: 0.086, lat: 258 },
      { type: 'brakeBoard', t: 0.118, lat: 15 },
      { type: 'tyreStack', t: 0.128, lat: -12.5, step: 0.005, end: 0.156 },
      { type: 'signChevron', t: 0.130, lat: 14.5, step: 0.006, end: 0.164 },
      // ---- the neon canyon --------------------------------------------------
      // `neonCantilever`'s across-road half-extent is 5.0 m — it is authored to
      // project TOWARD the road, which is the whole point of it — against a
      // corridor of hw 8.5 + kerb 1.55 + shoulder 2 = 12.05 m. lat 20 leaves the
      // outer edge of the hanging blade 3.0 m clear of the shoulder, so the sign
      // leans over the pavement and not over the tarmac.
      { type: 'neonCantilever', t: 0.176, lat: 20, step: 0.0072, end: 0.302, mirror: true },
      { type: 'marketStall', t: 0.182, lat: 19, step: 0.010, end: 0.296 },
      { type: 'trafficLight', t: 0.174, lat: -14 },
      { type: 'holoAd', t: 0.200, lat: 0, up: 11, step: 0.030, end: 0.286 },
      { type: 'signChevron', t: 0.300, lat: -14, step: 0.006, end: 0.330 },
      // ---- the tram street and the scaffolded block -------------------------
      // `bambooScaffold` reaches 10.2 m toward the road (the nylon canopy is what
      // sets that, and the recipe caps it deliberately). Against a corridor of
      // hw 10 + 1.55 + 3 = 14.55 m, lat 28 leaves 3.25 m of clear verge.
      { type: 'bambooScaffold', t: 0.352, lat: 28 },
      { type: 'tramHK', t: 0.340, lat: -15 },
      { type: 'tramHK', t: 0.372, lat: 15 },
      { type: 'streetLamp', t: 0.310, lat: 16, step: 0.020, end: 0.400 },
      { type: 'planter', t: 0.316, lat: -14, step: 0.016, end: 0.398 },
      { type: 'neonCantilever', t: 0.318, lat: -20, step: 0.010, end: 0.352 },
      // ---- the ladder streets ------------------------------------------------
      { type: 'brakeBoard', t: 0.360, lat: 15 },
      { type: 'signChevron', t: 0.372, lat: -14, step: 0.006, end: 0.404 },
      { type: 'tyreStack', t: 0.410, lat: 13, step: 0.005, end: 0.438 },
      { type: 'signChevron', t: 0.424, lat: 14, step: 0.006, end: 0.452 },
      { type: 'towerBlock', t: 0.430, lat: 44, step: 0.016, end: 0.552, mirror: true },
      // 13 m tall and 4 m across: kept back on the bank, which is where a
      // hillside tree belongs and where it cannot hide the road through a
      // switchback. Same lesson as Taipei's pines.
      { type: 'pine', t: 0.462, lat: 27, step: 0.014, end: 0.548 },
      { type: 'pine', t: 0.470, lat: -28, step: 0.016, end: 0.545 },
      // ---- the ridge ---------------------------------------------------------
      // NOT a cone. `lionRock` is three layered swept ridgelines with a blocky
      // crag on the near one; the owner's complaint about Taipei was "strange
      // pyramid structures in the background", and a low-poly cone at 400 m is
      // exactly that. Authored at lat 640 on the ONE unbanked band on this half
      // of the lap, because a lateral offset that size on a banked binormal buys
      // spurious altitude — 640 x sin(10 deg) would be 111 m of it.
      { type: 'lionRock', t: 0.560, lat: 640 },
      { type: 'crowdStand', t: 0.552, lat: -26 },
      { type: 'flagHK', t: 0.546, lat: 22 },
      { type: 'signChevron', t: 0.594, lat: -15, step: 0.006, end: 0.626 },
      // ---- Central ------------------------------------------------------------
      { type: 'skyscraper', t: 0.600, lat: 90, step: 0.022, end: 0.730, mirror: true, scale: 1.45 },
      { type: 'towerBlock', t: 0.604, lat: 43, step: 0.014, end: 0.720, mirror: true },
      { type: 'streetLamp', t: 0.606, lat: 17, step: 0.018, end: 0.745, mirror: true },
      { type: 'neonCantilever', t: 0.652, lat: 20, step: 0.008, end: 0.716, mirror: true },
      { type: 'trafficLight', t: 0.700, lat: 15 },
      { type: 'brakeBoard', t: 0.752, lat: -14 },
      { type: 'signChevron', t: 0.764, lat: 14, step: 0.006, end: 0.798 },
      // ---- the supertall sweep and the harbour-front plaza --------------------
      { type: 'billboard', t: 0.788, lat: -24, scale: 1.25 },
      { type: 'flagHK', t: 0.798, lat: -15, scale: 1.7 },
      { type: 'flagHK', t: 0.810, lat: -15 },
      { type: 'crowdStand', t: 0.802, lat: -26 },
      { type: 'tramHK', t: 0.824, lat: 17 },
      { type: 'planter', t: 0.790, lat: 15, step: 0.012, end: 0.832 },
      // ---- the harbour front and the run to the line --------------------------
      { type: 'seaWall', t: 0.852, lat: 20, step: 0.008, end: 0.908 },
      { type: 'flagPole', t: 0.858, lat: -19, step: 0.013, end: 0.904 },
      { type: 'streetLamp', t: 0.920, lat: 17, step: 0.016, end: 0.995, mirror: true },
      { type: 'skyscraper', t: 0.900, lat: -94, step: 0.024, end: 0.990, scale: 1.4 },
      { type: 'crowdStand', t: 0.968, lat: -27 },
    ],
    boostPads: [
      // On straights and corner exits only — the volcano lesson: a pad 23 m
      // before a tight corner is what made the AI spear the inside rail.
      { t: 0.198, lat: -4, width: 7, length: 16 },
      { t: 0.198, lat: 4, width: 7, length: 16 },
      { t: 0.500, lat: 0, width: 9, length: 15 },
      { t: 0.870, lat: 0, width: 10, length: 16 },
      { t: 0.960, lat: 0, width: 9, length: 16 },
    ],
    // Three rows a lap, before the overtaking spots. See Boston's note.
    itemRows: [
      { t: 0.226, count: 3, spread: 10 },
      { t: 0.560, count: 5 },
      { t: 0.885, count: 5 },
    ],
    // Off the racing line, and no oil: see the note on Boston's hazards.
    hazards: [
      { kind: 'slider', t: 0.640, lat: -9, span: 9, speed: 3 },
    ],
  },

  newYorkCircuit: {
    id: 'newYorkCircuit',
    name: 'New York Circuit',
    subtitle: 'An avenue canyon, the park and the river crossing',
    theme: 'city',
    // The bright one, on purpose. With Boston already `day` the two are
    // separated by everything else: masonry ziggurats against brick commercial
    // blocks, a park with a lake against a harbour quay, and a suspension
    // crossing against a cable-stayed one.
    skyPreset: 'day',
    weather: 'clear',
    laps: 3,
    terrainSeed: 27418,
    // Same measurement as Boston: no basin, so no plane. The boating lake is a
    // prop (`parkLake`) with its own coping and a 4 m apron.
    waterLevel: null,
    // Read by `Catalogue.toMenuTrack` as the course card's second gradient
    // stop — see the note on `hongKongHarbour.fogColor`. Matched to the live
    // `day` preset's #5c80b0.
    fogColor: 0x5c80b0,
    fogDensity: 0.0014,
    road: {
      // Midday, cool sky, stone city. `worn` is the lightest recipe and carries
      // the crack field a real avenue has; the tint is held a touch warm-grey so
      // the limestone and the yellow cabs have something to sit against.
      asphalt: 'worn',
      tint: 0xe6e4dd,
      kerbA: 0x2f4f8c,
      kerbB: 0xf4f1e8,
      line: 0xf6f2e4,
      verge: 0x8d8a83,
      rail: 0xb4bcc4,
      energy: 0x53d8ff,
      racingLine: 0.8,
      ao: 0.95,
    },
    defaults: { wallL: 'concrete', wallR: 'concrete', shoulderSurface: S.OffRoad },
    nodes: NEW_YORK_NODES,
    props: [
      // ---- WHICH CITY THIS IS ---------------------------------------------
      // See the note on Boston's `districtBrick`. `districtZiggurat` selects the
      // 1916 zoning envelope: a masonry ziggurat that steps back four times off
      // the lot line, with a water tank on the first setback, plus a substantial
      // minority of post-war glass slabs. No neon of any kind, no trams — the
      // signage on this circuit is a sponsor billboard and nothing else.
      { type: 'districtZiggurat', t: 0.0, lat: 0 },
      // ---- start / finish, on the avenue ----------------------------------
      { type: 'startGantry', t: 0.0, lat: 0 },
      { type: 'grandstand', t: 0.007, lat: -29, scale: 1.15 },
      { type: 'crowdStand', t: 0.026, lat: 27 },
      { type: 'flagUSA', t: 0.006, lat: 21, step: 0.009, end: 0.060, mirror: true },
      { type: 'balloonArch', t: 0.050, lat: 0, up: 0 },
      { type: 'skyscraper', t: 0.012, lat: 94, step: 0.021, end: 0.120, mirror: true, scale: 1.55 },
      { type: 'towerBlock', t: 0.016, lat: 45, step: 0.015, end: 0.122, mirror: true },
      { type: 'streetLamp', t: 0.020, lat: 17, step: 0.017, end: 0.122, mirror: true },
      // Cabs at the kerb. 2.4 m long and 1.0 m across the road, yawed 90 degrees
      // by the recipe's own placement convention, so lat 15.5 against a 19.05 m
      // corridor leaves them on the pavement edge where a rank belongs.
      { type: 'yellowCab', t: 0.030, lat: 15.5, step: 0.011, end: 0.116, mirror: true },
      // Steam off the street, one each side, on the kerb line rather than the
      // racing line: the plume starts AT the road surface, so there is nothing
      // suspended in the air about it.
      { type: 'steamVent', t: 0.042, lat: -13.5 },
      { type: 'steamVent', t: 0.086, lat: 13.5 },
      { type: 'brakeBoard', t: 0.120, lat: -15 },
      { type: 'tyreStack', t: 0.136, lat: 12.5, step: 0.005, end: 0.164 },
      { type: 'signChevron', t: 0.138, lat: -14.5, step: 0.006, end: 0.170 },
      // ---- THE TWO SKYLINE LANDMARKS ---------------------------------------
      // Both placed the way the Taipei supertall had to be: far enough back that
      // the whole thing fits the frustum. 190 m + 36 m of mast wants ~260 m and
      // 176 m wants ~215 m; the eye looks at the horizon, so only the upper half
      // of the vertical FOV is available above it. Re-measured in the report.
      { type: 'empireSpire', t: 0.104, lat: -262 },
      { type: 'chryslerCrown', t: 0.836, lat: 224 },
      // ---- the cross street --------------------------------------------------
      // `brownstoneRow`'s across-road half-extent is 6.3 m and `waterTankRow`'s
      // is 6.6 m (the fire escape), against a corridor of hw 9 + 1.55 + 2 =
      // 12.55 m. lat 22 and 24 leave 3.2 m and 4.9 m of clear verge, and the
      // steps match the recipes' own lengths (23.4 m and 15.6 m) so each run is
      // a continuous street wall rather than a row of detached blocks.
      { type: 'brownstoneRow', t: 0.180, lat: 22, step: 0.0148, end: 0.268, mirror: true },
      { type: 'waterTankRow', t: 0.276, lat: 24, step: 0.0099, end: 0.316, mirror: true },
      { type: 'streetLamp', t: 0.190, lat: 16, step: 0.026, end: 0.310 },
      { type: 'yellowCab', t: 0.200, lat: -14, step: 0.019, end: 0.300 },
      { type: 'planter', t: 0.196, lat: 14, step: 0.016, end: 0.296 },
      { type: 'trafficLight', t: 0.312, lat: 14 },
      { type: 'signChevron', t: 0.320, lat: -14, step: 0.006, end: 0.348 },
      // ---- the park ----------------------------------------------------------
      // The park is the INFIELD (a clockwise lap puts the inside on the driver's
      // right), so the tree line and the lake read across the inside of three
      // corners instead of past one hedge. `parkTree` is 3.4 m across at the
      // canopy against a corridor of hw 11 + 1.55 + 5 = 17.55 m, so lat 22 is
      // the minimum that keeps a canopy off the shoulder.
      { type: 'parkTree', t: 0.352, lat: 22, step: 0.0062, end: 0.452 },
      { type: 'parkTree', t: 0.356, lat: 34, step: 0.0090, end: 0.462 },
      { type: 'parkTree', t: 0.362, lat: -24, step: 0.0110, end: 0.448 },
      // The lake's across-road half-extent is 34 m (an irregular 17-sided rim),
      // so lat 78 puts its near coping 44 m in from the road: a lawn, then the
      // water, which is what you actually see from the park drive.
      { type: 'parkLake', t: 0.402, lat: 78 },
      { type: 'parkTree', t: 0.392, lat: 132, step: 0.014, end: 0.470 },
      { type: 'signChevron', t: 0.396, lat: -15, step: 0.006, end: 0.426 },
      { type: 'brakeBoard', t: 0.412, lat: -14 },
      { type: 'crowdStand', t: 0.372, lat: -27 },
      { type: 'tyreStack', t: 0.432, lat: 12, step: 0.005, end: 0.458 },
      { type: 'brakeBoard', t: 0.464, lat: 14 },
      // ---- THE EAST RIVER CROSSING -------------------------------------------
      // Two granite towers straddling their own deck at lat 0. `brooklyntower`
      // is in `CORRIDOR_PROPS`, so nothing pushes them aside and they keep the
      // deck's own height — which is the datum their cable web is solved
      // against, per stay, at that stay's own arc length.
      //
      // 95 m apart, and `BROOKLYN.reach` is 48 m each way, so the two cable webs
      // meet in the middle of the span exactly as a continuous main cable does.
      // No `bridgePylon` run underneath: the terrain bake follows an isolated
      // elevated deck, so a pier under it measures 100 % underground — that was
      // measured on Boston and on Tokyo and the answer has not changed.
      { type: 'brooklynTower', t: 0.534, lat: 0 },
      { type: 'brooklynTower', t: 0.594, lat: 0 },
      { type: 'signChevron', t: 0.632, lat: 14, step: 0.006, end: 0.660 },
      { type: 'brakeBoard', t: 0.624, lat: -14 },
      // ---- downtown -----------------------------------------------------------
      { type: 'waterTankRow', t: 0.670, lat: 24, step: 0.0102, end: 0.712, mirror: true },
      { type: 'towerBlock', t: 0.668, lat: 43, step: 0.014, end: 0.782, mirror: true },
      { type: 'skyscraper', t: 0.660, lat: 88, step: 0.022, end: 0.800, mirror: true, scale: 1.4 },
      { type: 'streetLamp', t: 0.678, lat: 17, step: 0.017, end: 0.790, mirror: true },
      { type: 'steamVent', t: 0.704, lat: -13.5 },
      { type: 'yellowCab', t: 0.700, lat: 15.5, step: 0.013, end: 0.772 },
      { type: 'billboard', t: 0.742, lat: -24, scale: 1.25 },
      { type: 'trafficLight', t: 0.726, lat: 15 },
      { type: 'brakeBoard', t: 0.764, lat: 15 },
      { type: 'signChevron', t: 0.772, lat: -15, step: 0.006, end: 0.804 },
      // ---- the crown sweep and the civic plaza --------------------------------
      // The ceremonial pair, on the plaza under the crown. See the flag scheme
      // note in Boston's props list.
      { type: 'flagUSA', t: 0.792, lat: -15, scale: 1.7 },
      { type: 'flagUSA', t: 0.804, lat: -15 },
      { type: 'flagUSA', t: 0.828, lat: 22 },
      { type: 'crowdStand', t: 0.820, lat: 26, step: 0.018, end: 0.856 },
      { type: 'planter', t: 0.788, lat: 16, step: 0.012, end: 0.830 },
      // ---- the run to the line -------------------------------------------------
      { type: 'streetLamp', t: 0.924, lat: 17, step: 0.016, end: 0.995, mirror: true },
      { type: 'yellowCab', t: 0.930, lat: 15.5, step: 0.012, end: 0.992 },
      { type: 'skyscraper', t: 0.898, lat: 92, step: 0.024, end: 0.988, scale: 1.45 },
      { type: 'crowdStand', t: 0.970, lat: -27 },
    ],
    boostPads: [
      { t: 0.208, lat: -4, width: 7, length: 16 },
      { t: 0.208, lat: 4, width: 7, length: 16 },
      { t: 0.560, lat: 0, width: 10, length: 16 },
      { t: 0.880, lat: 0, width: 9, length: 16 },
      { t: 0.958, lat: 0, width: 9, length: 16 },
    ],
    itemRows: [
      { t: 0.238, count: 3, spread: 10 },
      { t: 0.500, count: 5 },
      { t: 0.900, count: 5 },
    ],
    hazards: [
      { kind: 'snapper', t: 0.372, lat: 13 },
      { kind: 'slider', t: 0.700, lat: -9, span: 9, speed: 3 },
    ],
  },
};

/** Menu / cup order for the city series, appended after the original three. */
export const CITY_TRACK_ORDER: readonly string[] = [
  'bostonHarbor', 'taipeiCircuit', 'tokyoNeon', 'hongKongHarbour', 'newYorkCircuit',
];
