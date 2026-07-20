// Predicted finish-time range: a fade-parameter SENSITIVITY band, not a
// real-world confidence interval. See PLAN.md §13's "prediction intervals"
// entry -- explicitly scoped down after consulting on what a range should
// represent. This shows how much the predicted finish time would shift if
// tau were slightly different, given how well the athlete's own training
// data actually pins it down. It does NOT include day-of execution
// variance (weather, fueling, a bad day) or structural model error -- this
// project has only two backtest residuals (-0.2%, -9.2%) to speak of,
// nowhere near enough to calibrate a real-world range from.
//
// Built directly on pacingFit.ts's own bootstrapTauConfidenceInterval --
// this module's whole job is running each retained tau resample through
// the solver to turn "how much could tau vary" into "how much could the
// predicted finish time vary." Deliberately does NOT bootstrap the joint
// (fInf, tau) fit -- see bootstrapTauConfidenceInterval's own doc for why
// (that 2-D grid search is far more expensive per call than the 1-D tau
// search, and running it ~100 times per button click would be too slow
// for interactive use).

import type { CourseSegment } from "../gpx/pipeline";
import type { CeilingParams } from "./ceiling";
import {
  type BootstrapOptions,
  bootstrapTauConfidenceInterval,
  BOOTSTRAP_YIELD_EVERY,
  type EffortTrendPoint,
  percentile,
} from "./pacingFit";
import { findSustainableTheta, type SolverInputs } from "./solver";

export interface FinishTimeRangeResult {
  /** Which tier the POINT ESTIMATE (not each resample) used -- "defaults"
   * never reaches this far; predictFinishTimeRange returns null instead,
   * since there's nothing to build a sensitivity band around. */
  tier: "joint" | "tauOnly";
  pointEstimateFinishTimeS: number;
  lowFinishTimeS: number;
  medianFinishTimeS: number;
  highFinishTimeS: number;
  /** Resamples that produced a usable tau-only fit and were included in
   * low/median/high below. Mirrors bootstrapTauConfidenceInterval's own
   * sampleCount/skippedCount -- see its doc for why a resample that can't
   * clear the support gate is skipped, not substituted with a default. */
  sampleCount: number;
  skippedCount: number;
}

export type PredictFinishTimeRangeOptions = BootstrapOptions;

/**
 * Null when the underlying tau fit itself can't clear the support gate
 * (the real Soria Moria case: not enough informative races even for a
 * tau-only fit) -- see bootstrapTauConfidenceInterval's own doc. Otherwise
 * runs findSustainableTheta once at the point estimate and once per
 * retained bootstrap tau sample, on targetSegments, to build a p10/p50/p90
 * band around the predicted finish time.
 */
export async function predictFinishTimeRange(
  races: EffortTrendPoint[][],
  raceDates: (Date | null)[],
  ceilingParams: CeilingParams,
  solverBaseInputs: Omit<SolverInputs, "segments" | "ceilingParams">,
  targetSegments: CourseSegment[],
  opts: PredictFinishTimeRangeOptions = {},
): Promise<FinishTimeRangeResult | null> {
  const tauBootstrap = await bootstrapTauConfidenceInterval(races, raceDates, ceilingParams, opts);
  if (!tauBootstrap) return null;

  const solve = (tauMin: number) =>
    findSustainableTheta({
      ...solverBaseInputs,
      segments: targetSegments,
      ceilingParams: { ...tauBootstrap.pointEstimateCeilingParams, tauMin },
    }).result.finishTimeS;

  const pointEstimateFinishTimeS = solve(tauBootstrap.pointEstimateTauMin);

  const bootstrapFinishTimes: number[] = [];
  for (let i = 0; i < tauBootstrap.tauSamples.length; i++) {
    if (i > 0 && i % BOOTSTRAP_YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    bootstrapFinishTimes.push(solve(tauBootstrap.tauSamples[i]));
  }
  bootstrapFinishTimes.sort((a, b) => a - b);

  const sampleCount = bootstrapFinishTimes.length;
  const [low, median, high] =
    sampleCount > 0
      ? [percentile(bootstrapFinishTimes, 0.1), percentile(bootstrapFinishTimes, 0.5), percentile(bootstrapFinishTimes, 0.9)]
      : [pointEstimateFinishTimeS, pointEstimateFinishTimeS, pointEstimateFinishTimeS];

  return {
    tier: tauBootstrap.tier,
    pointEstimateFinishTimeS,
    lowFinishTimeS: low,
    medianFinishTimeS: median,
    highFinishTimeS: high,
    sampleCount,
    skippedCount: tauBootstrap.skippedCount,
  };
}
