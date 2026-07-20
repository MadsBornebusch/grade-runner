// "Running impact" -- reverse-engineered to match an external per-run
// mechanical-impact score (an athlete-facing metric this app doesn't produce
// itself), by least-squares fitting against known (distance, elevation,
// score) tuples and validating out-of-sample. NOT a physiologically derived
// quantity, and NOT the same score as descentImpact.ts's -- that module
// tests a *speed*-weighted descent hypothesis; this one tests a pure
// distance-plus-grade-cost hypothesis, and empirically wins.
//
// Provenance: coefficients fit on one 7-run training week (21-26 Apr 2026)
// only, then validated *without refitting* against three independent
// held-out sets -- a separate May training week (RMSE 2.79 across 7 runs),
// a point-to-point long run (19 Apr 2026: +1.1% error), and a point-to-point
// ultra (Soria Moria: -4.2% error). A literature-motivated hypothesis that
// descent should carry extra weight (mechanically punishing even though
// metabolically cheap) was tested explicitly using the two point-to-point
// runs, which are the only ones with genuine ascent!=descent asymmetry
// (every April/May run is a loop, so ascent and descent are collinear
// there). Every 3-parameter descent-weighted variant tried fit the two
// point-to-point runs near-perfectly but generalized *worse* on the May
// holdout than this plain 2-parameter model -- clear overfitting to two
// high-leverage points, not a real signal. Treat the coefficients below as a
// small-sample empirical fit to one athlete's data against an unpublished
// scoring formula, not a validated universal constant.

import type { CourseSegment } from "../gpx/pipeline";
import { costOfRunning } from "./minetti";

export interface RunningImpactCoefficients {
  /** Per km of along-slope distance. */
  distanceCoefficient: number;
  /** Per km of hillSurchargeKm (see below). */
  hillSurchargeCoefficient: number;
}

export const DEFAULT_RUNNING_IMPACT_COEFFICIENTS: RunningImpactCoefficients = {
  distanceCoefficient: 6.9098,
  hillSurchargeCoefficient: 10.6943,
};

const FLAT_COST = costOfRunning(0);

/**
 * Grade-adjusted-equivalent distance attributable to gradient alone, in km --
 * how much *extra* flat-equivalent distance this course's hills are "worth",
 * per the Minetti cost-of-running curve, isolated from plain distance. Zero
 * on a flat course. Can go negative: costOfRunning dips below flat cost
 * around grade ~ -10% (gentle descents are metabolically cheaper than flat),
 * so a course with enough gentle-but-not-steep descent nets a negative
 * surcharge -- intended, not a bug.
 *
 * Deliberately mixes distance conventions -- distanceHorizontal here, but
 * distance3D in runningImpact()'s own distance term -- rather than using one
 * consistently, despite PLAN.md §5's general along-slope convention for
 * cost/speed/splits elsewhere in this app. That mix is exactly what
 * DEFAULT_RUNNING_IMPACT_COEFFICIENTS were fit and validated against;
 * "fixing" it would silently swap in a different, unvalidated formula under
 * the same trusted coefficients.
 */
export function hillSurchargeKm(segments: CourseSegment[]): number {
  let gradeAdjustedM = 0;
  let flatM = 0;
  for (const seg of segments) {
    gradeAdjustedM += seg.distanceHorizontal * (costOfRunning(seg.gradient) / FLAT_COST);
    flatM += seg.distanceHorizontal;
  }
  return (gradeAdjustedM - flatM) / 1000;
}

/**
 * Empirical "running impact" score. `segments` must start at the course's
 * own first segment (a whole course, or an early-window prefix slice of one
 * -- the same pattern withinRaceDescentDiagnostic.ts uses) -- the distance
 * term reads `cumulativeDistance3D` off the last segment, which is
 * cumulative from the *course's* start, not the slice's. A slice that
 * doesn't start at index 0 (e.g. a late-window suffix) would silently
 * overcount distance. hillSurchargeKm() itself has no such restriction. See
 * module doc comment for what this score is and isn't.
 */
export function runningImpact(
  segments: CourseSegment[],
  coefficients: RunningImpactCoefficients = DEFAULT_RUNNING_IMPACT_COEFFICIENTS,
): number {
  const distanceKm = (segments.at(-1)?.cumulativeDistance3D ?? 0) / 1000;
  return (
    coefficients.distanceCoefficient * distanceKm + coefficients.hillSurchargeCoefficient * hillSurchargeKm(segments)
  );
}
