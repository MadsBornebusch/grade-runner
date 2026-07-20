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
// Deliberately does NOT bootstrap the joint (fInf, tau) fit -- that 2-D
// grid search is far more expensive per call than the 1-D tau search, and
// running it ~100 times per button click would be too slow for interactive
// use. Bootstrap resamples vary tau only, holding fInf at whatever the
// point estimate resolved to -- consistent with this project's existing
// "tau is the higher-confidence, primary parameter; fInf is documented
// lower-confidence" framing (see fitFInfAndTauAcrossRaces's own doc).
//
// A resample that can't itself clear the same informative-race-count gate
// the point estimate had to clear is SKIPPED, not replaced with a default
// value: mixing "genuinely refit" samples with "fell back to defaults"
// samples in one distribution produces a bimodal, meaningless spread, not
// a wide-but-honest one -- the reason nonparametric bootstrap-over-races
// is degenerate at low informativeRaceCount, caught before building this
// (see the real Soria Moria case, informativeRaceCount=1/27).

import type { CourseSegment } from "../gpx/pipeline";
import type { CeilingParams } from "./ceiling";
import { type EffortTrendPoint, fitTauAcrossRaces, fitTauFInfWithSupportGate, MIN_INFORMATIVE_RACES } from "./pacingFit";
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
   * low/median/high below. */
  sampleCount: number;
  /** Resamples dropped for failing the same support gate the point
   * estimate had to clear -- see the module doc comment on why these are
   * skipped rather than substituted with a default value. */
  skippedCount: number;
}

const DEFAULT_BOOTSTRAP_SAMPLES = 100;
/** Yield to the event loop this often during the bootstrap loop so the
 * browser tab stays responsive across ~100 sequential fit+solve calls. */
const YIELD_EVERY = 10;

/** Linear-interpolation percentile over an already-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface PredictFinishTimeRangeOptions {
  bootstrapSamples?: number;
  /** Injectable for deterministic tests -- defaults to Math.random. */
  rng?: () => number;
}

/**
 * Null when the point estimate itself can't clear the support gate (the
 * real Soria Moria case: not enough informative races even for a tau-only
 * fit) -- refusing a number here mirrors fitTauFInfWithSupportGate's own
 * "defaults" tier refusing to trust a single-race-driven fit. Otherwise,
 * bootstraps tau (holding fInf fixed) to build a p10/p50/p90 band around
 * the point estimate's own predicted finish time on targetSegments.
 */
export async function predictFinishTimeRange(
  races: EffortTrendPoint[][],
  raceDates: (Date | null)[],
  ceilingParams: CeilingParams,
  solverBaseInputs: Omit<SolverInputs, "segments" | "ceilingParams">,
  targetSegments: CourseSegment[],
  opts: PredictFinishTimeRangeOptions = {},
): Promise<FinishTimeRangeResult | null> {
  const bootstrapSamples = opts.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const rng = opts.rng ?? Math.random;

  const pointFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates });
  if (pointFit.tier === "defaults") return null;

  const pointEstimateFinishTimeS = findSustainableTheta({
    ...solverBaseInputs,
    segments: targetSegments,
    ceilingParams: pointFit.ceilingParams,
  }).result.finishTimeS;

  const bootstrapFinishTimes: number[] = [];
  let skippedCount = 0;

  for (let i = 0; i < bootstrapSamples; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const indices = races.map(() => Math.floor(rng() * races.length));
    const resampledRaces = indices.map((idx) => races[idx]);
    const resampledDates = indices.map((idx) => raceDates[idx]);

    const tauFit = fitTauAcrossRaces(resampledRaces, pointFit.ceilingParams, { raceDates: resampledDates });
    if (!tauFit || tauFit.informativeRaceCount < MIN_INFORMATIVE_RACES || tauFit.hitSearchBoundary) {
      skippedCount++;
      continue;
    }

    const { result } = findSustainableTheta({
      ...solverBaseInputs,
      segments: targetSegments,
      ceilingParams: { ...pointFit.ceilingParams, tauMin: tauFit.tauMin },
    });
    bootstrapFinishTimes.push(result.finishTimeS);
  }

  bootstrapFinishTimes.sort((a, b) => a - b);
  const sampleCount = bootstrapFinishTimes.length;

  const [low, median, high] =
    sampleCount > 0
      ? [percentile(bootstrapFinishTimes, 0.1), percentile(bootstrapFinishTimes, 0.5), percentile(bootstrapFinishTimes, 0.9)]
      : [pointEstimateFinishTimeS, pointEstimateFinishTimeS, pointEstimateFinishTimeS];

  return {
    tier: pointFit.tier,
    pointEstimateFinishTimeS,
    lowFinishTimeS: low,
    medianFinishTimeS: median,
    highFinishTimeS: high,
    sampleCount,
    skippedCount,
  };
}
