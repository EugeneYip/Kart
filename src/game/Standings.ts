/**
 * ============================================================================
 *  STANDINGS — Grand Prix points across a four-race cup
 * ============================================================================
 *  MK8's scoring, exactly: 15/12/10/9/8/7/6/5/4/3/2/1 for a twelve-kart grid.
 *  Ties break on the most recent finishing position, then on cumulative time —
 *  which is what the real game does, and it matters on the last race of a cup.
 * ============================================================================
 */

import type { RaceResult } from './RaceState';

/** Points by finishing position, index 0 = 1st place. */
export const GP_POINTS: readonly number[] = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** Races in a cup. */
export const CUP_RACES = 4;

export function pointsForPosition(position: number): number {
  const i = Math.floor(position) - 1;
  if (i < 0) return 0;
  return i < GP_POINTS.length ? GP_POINTS[i] : 0;
}

export interface StandingRow {
  kartId: number;
  points: number;
  /** Finishing position per completed race, in order. */
  positions: number[];
  bestFinish: number;
  totalTime: number;
  /** 1-based rank in the cup. */
  rank: number;
}

export interface CupSummary {
  raceIndex: number;
  raceCount: number
  complete: boolean;
  rows: StandingRow[];
  /** Kart id of the cup winner once complete, else -1. */
  winner: number;
}

export class Standings {
  private rows = new Map<number, StandingRow>();
  private completedRaces = 0;
  private races: number;
  /** Track ids in cup order, if the caller supplies them. */
  readonly trackIds: string[] = [];

  constructor(raceCount = CUP_RACES) {
    this.races = Math.max(1, Math.floor(raceCount));
  }

  /** Start a fresh cup for this grid. */
  beginCup(kartIds: readonly number[], trackIds?: readonly string[], raceCount = this.races): void {
    this.races = Math.max(1, Math.floor(raceCount));
    this.rows.clear();
    this.completedRaces = 0;
    this.trackIds.length = 0;
    if (trackIds) for (const id of trackIds) this.trackIds.push(id);
    for (const id of kartIds) {
      this.rows.set(id, {
        kartId: id, points: 0, positions: [], bestFinish: Number.POSITIVE_INFINITY,
        totalTime: 0, rank: 0,
      });
    }
  }

  get raceIndex(): number { return this.completedRaces; }
  get raceCount(): number { return this.races; }
  get isComplete(): boolean { return this.completedRaces >= this.races; }

  /** Fold one race's results into the cup. */
  recordRace(results: ReadonlyArray<Pick<RaceResult, 'kartId' | 'position' | 'time'>>): void {
    if (results.length === 0) return;
    for (const r of results) {
      let row = this.rows.get(r.kartId);
      if (!row) {
        row = {
          kartId: r.kartId, points: 0, positions: [], bestFinish: Number.POSITIVE_INFINITY,
          totalTime: 0, rank: 0,
        };
        this.rows.set(r.kartId, row);
      }
      row.points += pointsForPosition(r.position);
      row.positions.push(r.position);
      if (r.position < row.bestFinish) row.bestFinish = r.position;
      row.totalTime += isFinite(r.time) ? r.time : 0;
    }
    this.completedRaces++;
    this.rank();
  }

  private rank(): void {
    const list = this.table();
    for (let i = 0; i < list.length; i++) list[i].rank = i + 1;
  }

  /** Cumulative standings, leader first. */
  table(): StandingRow[] {
    const list = Array.from(this.rows.values());
    list.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      // Most recent race is the first tie-break — as in MK8.
      const la = a.positions.length ? a.positions[a.positions.length - 1] : 99;
      const lb = b.positions.length ? b.positions[b.positions.length - 1] : 99;
      if (la !== lb) return la - lb;
      if (a.bestFinish !== b.bestFinish) return a.bestFinish - b.bestFinish;
      if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
      return a.kartId - b.kartId;
    });
    for (let i = 0; i < list.length; i++) list[i].rank = i + 1;
    return list;
  }

  points(kartId: number): number { return this.rows.get(kartId)?.points ?? 0; }
  position(kartId: number): number { return this.rows.get(kartId)?.rank ?? 0; }

  /** Full cup snapshot, for the results screen. */
  summary(): CupSummary {
    const rows = this.table();
    return {
      raceIndex: this.completedRaces,
      raceCount: this.races,
      complete: this.isComplete,
      rows,
      winner: this.isComplete && rows.length > 0 ? rows[0].kartId : -1,
    };
  }

  /** Final cup ranking — kart ids, winner first. */
  cupRanking(): number[] {
    return this.table().map((r) => r.kartId);
  }

  reset(): void {
    this.rows.clear();
    this.completedRaces = 0;
    this.trackIds.length = 0;
  }
}
