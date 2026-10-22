// Estimates VO2max from a single hard, threshold-duration effort by
// inverting the app's own aerobic ceiling curve -- not an external formula
// (e.g. Daniels-Gilbert) that was never validated against this app's own
// Minetti-based cost model. See PLAN.md §12.
//
// ceilingPower(t; vo2max) is exactly linear in vo2max (the duration curve,
// altitude factor and durability drift don't depend on it), so if this run
// was a genuine all-out effort for its own length -- gross power ~= the
// ceiling for a race this long, with the true vo2max -- then analyzeRun's
// raceEffortFraction (against whatever vo2max is assumed) equals
// trueVo2max / assumedVo2max:
//
//   trueVo2max = assumedVo2max * raceEffortFraction
//
// It has to be the ceiling for the run's whole duration, not for the time
// elapsed so far (avgEffortFraction): that one is 100% of VO2max in the
// opening minutes, so an evenly paced race reads low early and the
// estimate came out several ml/kg/min short.
//
// This only holds if the run really was a near-maximal effort for its
// length -- an easy run that happens to be 40 minutes long would just
// underestimate vo2max. GPS data alone can't verify that, so callers only
// offer this for runs flagged as likely hard efforts (see
// suggestRunsForFit), as an estimate the athlete reviews before adding.

import type { AnalysisResult } from "./analysis";
import type { CeilingParams } from "./ceiling";

/** Below this, the model's own duration curve is flat at the LT2 cap for
 * typical params -- too short to say anything the model's shape doesn't
 * already assume. Above it, the durability suggestion bucket already
 * targets endurance-paced (not near-maximal) runs. See PLAN.md §12. */
export const MIN_ESTIMABLE_DURATION_MIN = 20;
export const MAX_ESTIMABLE_DURATION_MIN = 90;

export function isEstimableEffort(durationMin: number): boolean {
  return durationMin >= MIN_ESTIMABLE_DURATION_MIN && durationMin <= MAX_ESTIMABLE_DURATION_MIN;
}

/** Null if this run's duration falls outside the window where treating it
 * as a genuine time-trial effort is defensible, or if there's no usable
 * effort signal (e.g. no moving time). */
export function estimateVo2MaxFromRun(analysis: AnalysisResult, ceilingParams: CeilingParams): number | null {
  const durationMin = analysis.totalMovingTimeS / 60;
  if (!isEstimableEffort(durationMin)) return null;
  if (analysis.raceEffortFraction <= 0) return null;
  const assumedVo2Max = ceilingParams.vo2MaxMlPerKgPerMin ?? 50;
  return assumedVo2Max * analysis.raceEffortFraction;
}
