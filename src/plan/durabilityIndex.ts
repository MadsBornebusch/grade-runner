// PLAN.md §15 "Muscular durability", design point 3: does this athlete's
// descent speed hold up late in long runs? Fitness (fitnessIndex.ts) says
// whether the engine improves; this says whether the legs hold up.
//
// Per run: the change in descent speed from an early window to a late
// window of moving time, within fixed grade bands. Raw speed, not a
// grade-adjusted pace: Minetti's cost curve turns back up below about -20%,
// so a metabolic adjustment says nothing about how fast a steep descent can
// be run. Within each band the fit is log(speed) ~ grade + late, so a late
// window that happens to sit on steeper ground than the early one (-16% vs
// -11%, both in the -10..-17% band) doesn't read as fatigue. Bands are
// combined weighted by their information (early x late time / total).
//
// A flat-and-gentle companion (grade-adjusted speed, running gait only, so
// walk breaks don't count as fade) separates leg-specific loss on descents
// from a general slowdown, which on a long run is mostly pacing and the
// aerobic side.
//
// "Late is slower" is near-certain on any long run and means nothing on its
// own: routes put their descents in particular places, and people go out
// hard. The checks live in scripts/diagDurabilityIndex.ts (a placebo
// split, dose-response with duration and early descent, block bootstrap
// noise) and, for v2 below, scripts/diagDurabilityTiles.ts. Neither version
// passed stage 2's gate on this athlete's history (PLAN.md §15, "Gate
// decision"): the plan doesn't act on either reading.

import type { CourseSegment } from "../gpx/pipeline";
import { gradeAdjustedSpeedMs } from "../model/minetti";
import { solveLinearSystem } from "../model/linearSolve";

export interface PaceSample {
  /** Moving time at the end of the segment, s. */
  tS: number;
  dtS: number;
  gradient: number;
  speedMs: number;
}

/** Speeds outside this range are GPS artifacts or stops, not running. */
const MIN_SPEED_MS = 0.3;
const MAX_SPEED_MS = 8;
/** Same gait split as analysis.ts's DEFAULT_WALK_MAX_MS. */
export const WALK_MAX_MS = 2;

export function paceSamples(segments: CourseSegment[]): PaceSample[] {
  const out: PaceSample[] = [];
  let t = 0;
  for (const seg of segments) {
    if (seg.paused || seg.dtS === null || !(seg.dtS > 0)) continue;
    t += seg.dtS;
    const speedMs = seg.distance3D / seg.dtS;
    if (speedMs < MIN_SPEED_MS || speedMs > MAX_SPEED_MS) continue;
    out.push({ tS: t, dtS: seg.dtS, gradient: seg.gradient, speedMs });
  }
  return out;
}

/** [lo, hi) grade ranges. The steepest band starts at -17%, where the
 * steep-descent threshold §15 proposes for the load ledger. */
export const DESCENT_BANDS: [number, number][] = [
  [-0.1, -0.05],
  [-0.17, -0.1],
  [-0.45, -0.17],
];

/** A band counts only with at least this much time in *both* windows. */
export const MIN_BAND_S = 180;

export interface BandFade {
  band: [number, number];
  earlyS: number;
  lateS: number;
  earlyGrade: number;
  lateGrade: number;
  /** log(late speed / early speed) at equal grade. */
  logFade: number;
}

export interface FadeResult {
  /** Information-weighted mean of the bands' logFade; null without any
   * band that has MIN_BAND_S in both windows. */
  logFade: number | null;
  bands: BandFade[];
}

/** Weighted fit of log(speed) on [1, grade, late]; returns the `late`
 * coefficient. Grade is centred first so the system stays well conditioned. */
function lateCoefficient(early: PaceSample[], late: PaceSample[]): number | null {
  const all = [...early.map((s) => ({ s, l: 0 })), ...late.map((s) => ({ s, l: 1 }))];
  const w = all.reduce((acc, x) => acc + x.s.dtS, 0);
  const g0 = all.reduce((acc, x) => acc + x.s.dtS * x.s.gradient, 0) / w;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const { s, l } of all) {
    const row = [1, s.gradient - g0, l];
    const y = Math.log(s.speedMs);
    for (let p = 0; p < 3; p++) {
      b[p] += s.dtS * row[p] * y;
      for (let q = 0; q < 3; q++) A[p][q] += s.dtS * row[p] * row[q];
    }
  }
  // A band with no grade spread can't separate grade from window; fall back
  // to the plain difference of means.
  if (A[1][1] < 1e-6 * w) {
    const m = (xs: PaceSample[]) => xs.reduce((acc, s) => acc + s.dtS * Math.log(s.speedMs), 0) / xs.reduce((acc, s) => acc + s.dtS, 0);
    return m(late) - m(early);
  }
  const beta = solveLinearSystem(A, b);
  return beta ? beta[2] : null;
}

const timeOf = (xs: PaceSample[]) => xs.reduce((acc, s) => acc + s.dtS, 0);
const meanGrade = (xs: PaceSample[]) => xs.reduce((acc, s) => acc + s.dtS * s.gradient, 0) / timeOf(xs);

/** Descent-speed fade between two windows' samples (already split). */
export function descentFade(early: PaceSample[], late: PaceSample[], bands = DESCENT_BANDS, minBandS = MIN_BAND_S): FadeResult {
  const out: BandFade[] = [];
  let num = 0;
  let den = 0;
  for (const band of bands) {
    const inBand = (s: PaceSample) => s.gradient >= band[0] && s.gradient < band[1];
    const e = early.filter(inBand);
    const l = late.filter(inBand);
    const earlyS = timeOf(e);
    const lateS = timeOf(l);
    if (earlyS < minBandS || lateS < minBandS) continue;
    const logFade = lateCoefficient(e, l);
    if (logFade === null) continue;
    out.push({ band, earlyS, lateS, earlyGrade: meanGrade(e), lateGrade: meanGrade(l), logFade });
    const info = (earlyS * lateS) / (earlyS + lateS);
    num += info * logFade;
    den += info;
  }
  return { logFade: den > 0 ? num / den : null, bands: out };
}

/** Grades the flat companion uses: gentle descents up to moderate climbs,
 * where running is the normal gait. */
export const FLAT_BAND: [number, number] = [-0.05, 0.08];

/** log(late / early) of time-weighted mean grade-adjusted speed, running
 * gait only, within FLAT_BAND; null below minBandS in either window. */
export function flatFade(early: PaceSample[], late: PaceSample[], minBandS = MIN_BAND_S): number | null {
  const keep = (s: PaceSample) => s.gradient >= FLAT_BAND[0] && s.gradient < FLAT_BAND[1] && s.speedMs > WALK_MAX_MS;
  const e = early.filter(keep);
  const l = late.filter(keep);
  if (timeOf(e) < minBandS || timeOf(l) < minBandS) return null;
  const m = (xs: PaceSample[]) => xs.reduce((acc, s) => acc + s.dtS * Math.log(gradeAdjustedSpeedMs(s.speedMs, s.gradient, "run")), 0) / timeOf(xs);
  return m(l) - m(e);
}

/** The samples whose moving time falls in [fromFraction, toFraction) of the
 * part of the run after `skipStartS` (the warm-up, when early descents are
 * often run cautiously and would hide fade). */
export function movingWindow(samples: PaceSample[], fromFraction: number, toFraction: number, skipStartS = 900): PaceSample[] {
  const end = samples.at(-1)?.tS ?? 0;
  const span = end - skipStartS;
  if (!(span > 0)) return [];
  const lo = skipStartS + fromFraction * span;
  const hi = skipStartS + toFraction * span;
  return samples.filter((s) => s.tS > lo && s.tS <= hi);
}

// ---- v2: the same descent at different times into different runs ---------
//
// v1 above compares a run's early descents with its own late ones, which are
// different descents (PLAN.md §15 stage 2: route terrain swamps the fade).
// v2 matches terrain across runs instead: a descent passage is one visit to
// a small map tile in one direction, and the fit is
//   log speed = tile effect + run effect + beta x hours into the run,
// so the tile effect absorbs the terrain, the run effect the day's fitness
// and chosen effort, and beta comes only from the same descent being run
// at different times into different runs.

export interface Passage {
  /** Map tile and heading, e.g. "1199123,107001,3". */
  tile: string;
  /** Moving hours into the run at this visit. */
  hours: number;
  logSpeed: number;
}

export interface PassageOptions {
  /** [lo, hi) grade range a segment must fall in. */
  grade: [number, number];
  /** Keep only running-gait segments (above WALK_MAX_MS). */
  runningOnly?: boolean;
  /** Tile edge in degrees of latitude; longitude uses twice this, about
   * square at 60 N. */
  tileDeg?: number;
  /** Drop visits in the first this-many moving seconds (warm-up). */
  skipStartS?: number;
  /** A repeat visit to the same tile in the same run counts only after this
   * many moving seconds (laps on a loop count; one tile split across two
   * consecutive segments doesn't). */
  revisitS?: number;
}

export const DESCENT_PASSAGE_GRADE: [number, number] = [-0.45, -0.05];
export const FLAT_PASSAGE_GRADE: [number, number] = [-0.03, 0.03];
const DEFAULT_TILE_DEG = 0.0005;

/**
 * One run's passages. `routePoints` is the pipeline's own (index i + 1 is
 * segments[i]'s endpoint); the heading is taken from the segment's own
 * start and end, in 8 sectors, so a descent and the same path climbed the
 * other way are different tiles.
 */
export function runPassages(
  segments: CourseSegment[],
  routePoints: { lat: number; lon: number }[],
  options: PassageOptions,
): Passage[] {
  const tileDeg = options.tileDeg ?? DEFAULT_TILE_DEG;
  const skipStartS = options.skipStartS ?? 600;
  const revisitS = options.revisitS ?? 600;
  const lastVisit = new Map<string, number>();
  const out: Passage[] = [];
  let t = 0;
  segments.forEach((seg, i) => {
    if (seg.paused || seg.dtS === null || !(seg.dtS > 0)) return;
    t += seg.dtS;
    if (seg.gradient < options.grade[0] || seg.gradient >= options.grade[1] || t < skipStartS) return;
    const speedMs = seg.distance3D / seg.dtS;
    if (speedMs < MIN_SPEED_MS || speedMs > MAX_SPEED_MS) return;
    if (options.runningOnly && speedMs <= WALK_MAX_MS) return;
    const a = routePoints[i];
    const b = routePoints[i + 1];
    if (!a || !b) return;
    const heading = Math.round(Math.atan2(b.lat - a.lat, (b.lon - a.lon) * 0.5) / (Math.PI / 4)) & 7;
    const tile = `${Math.round(b.lat / tileDeg)},${Math.round(b.lon / (2 * tileDeg))},${heading}`;
    const prev = lastVisit.get(tile);
    lastVisit.set(tile, t);
    if (prev !== undefined && t - prev < revisitS) return;
    out.push({ tile, hours: t / 3600, logSpeed: Math.log(speedMs) });
  });
  return out;
}

export interface FadeObservation extends Passage {
  run: string;
  /** Which beta this passage informs (e.g. a 12-week block). */
  group: string;
}

/**
 * Least squares of logSpeed on one hours slope per group, with tile and run
 * fixed effects, by alternating projections (Frisch-Waugh: demean y and
 * each regressor by tile and run in turn until stable, then plain OLS).
 * `maxHours` caps the dose, so the longest races don't set the slope.
 * Tiles that recur in fewer than `minRuns` runs carry no terrain match and
 * are dropped first. Returns log-speed change per hour for each group.
 */
export function fitTileFade(
  observations: FadeObservation[],
  options: { maxHours?: number; minRuns?: number; iterations?: number } = {},
): Map<string, number> {
  const maxHours = options.maxHours ?? 5;
  const minRuns = options.minRuns ?? 3;
  const iterations = options.iterations ?? 50;
  const runsPerTile = new Map<string, Set<string>>();
  for (const o of observations) {
    if (o.hours > maxHours) continue;
    (runsPerTile.get(o.tile) ?? runsPerTile.set(o.tile, new Set()).get(o.tile)!).add(o.run);
  }
  const obs = observations.filter((o) => o.hours <= maxHours && (runsPerTile.get(o.tile)?.size ?? 0) >= minRuns);
  const groups = [...new Set(obs.map((o) => o.group))].sort();
  const g = new Map(groups.map((x, k) => [x, k]));
  const columns = [obs.map((o) => o.logSpeed), ...groups.map((grp) => obs.map((o) => (o.group === grp ? o.hours : 0)))];
  const tileIdx = indexBy(obs.map((o) => o.tile));
  const runIdx = indexBy(obs.map((o) => o.run));
  for (const col of columns) {
    for (let it = 0; it < iterations; it++) {
      demean(col, tileIdx);
      demean(col, runIdx);
    }
  }
  const k = groups.length;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  for (let n = 0; n < obs.length; n++) {
    for (let p = 0; p < k; p++) {
      rhs[p] += columns[1 + p][n] * columns[0][n];
      for (let q = 0; q < k; q++) A[p][q] += columns[1 + p][n] * columns[1 + q][n];
    }
  }
  const out = new Map<string, number>();
  // A group whose runs all visit tiles at one time only has no column left.
  const identified = groups.filter((_, p) => A[p][p] > 1e-9);
  const keep = identified.map((grp) => g.get(grp)!);
  const beta = solveLinearSystem(keep.map((p) => keep.map((q) => A[p][q])), keep.map((p) => rhs[p]));
  if (beta) identified.forEach((grp, j) => out.set(grp, beta[j]));
  return out;
}

function indexBy(keys: string[]): { of: number[]; count: number } {
  const ids = new Map<string, number>();
  return { of: keys.map((x) => ids.get(x) ?? ids.set(x, ids.size).get(x)!), count: ids.size };
}

function demean(col: number[], idx: { of: number[]; count: number }): void {
  const sum = new Array<number>(idx.count).fill(0);
  const n = new Array<number>(idx.count).fill(0);
  for (let i = 0; i < col.length; i++) { sum[idx.of[i]] += col[i]; n[idx.of[i]]++; }
  for (let i = 0; i < col.length; i++) col[i] -= sum[idx.of[i]] / n[idx.of[i]];
}
