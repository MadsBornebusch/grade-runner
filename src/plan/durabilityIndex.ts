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
// hard. The checks that make this usable live in
// scripts/diagDurabilityIndex.ts (a placebo split, dose-response with
// duration and early descent, block bootstrap noise).

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
