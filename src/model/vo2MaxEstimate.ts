// Estimates VO2max from a single hard, threshold-duration effort by
// inverting the app's own aerobic ceiling curve -- not an external formula
// (e.g. Daniels-Gilbert) that was never validated against this app's own
// Minetti-based cost model. See PLAN.md §12.
//
// ceilingPower(t; vo2max) is exactly linear in vo2max at every instant (the
// duration curve, altitude factor, and durability drift don't depend on
// vo2max at all), so if this run was executed as a genuine near-ceiling
// effort for its own duration -- i.e. grossPower(t) ~= ceilingPower(t;
// trueVo2max) throughout -- then analyzeRun's avgEffortFraction (computed
// against whatever vo2max is currently assumed) equals trueVo2max /
// assumedVo2max at every instant, constant regardless of how the duration
// curve, altitude, or drift vary within the run. Multiplying back out:
//
//   trueVo2max = assumedVo2max * avgEffortFraction
//
// This only holds if the run really was paced at a roughly constant
// %-of-ceiling near-maximal effort for its own length -- an easy run that
// happens to be 40 minutes long would just underestimate vo2max, not
// reveal anything. That's a pacing assumption GPS data alone can't verify;
// callers should only offer this for runs already flagged as likely hard
// efforts (see suggestRunsForFit), and treat the result as a "race"-sourced
// estimate the athlete reviews before adding, not an automatic overwrite.

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
  if (analysis.avgEffortFraction <= 0) return null;
  const assumedVo2Max = ceilingParams.vo2MaxMlPerKgPerMin ?? 50;
  return assumedVo2Max * analysis.avgEffortFraction;
}
