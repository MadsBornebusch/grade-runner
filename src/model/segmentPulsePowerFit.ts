// PLAN.md §14 Plan B, Stage 7 follow-up: does pulse actually track modelled
// (or measured) power at monotonic-segment granularity? Stage 7's three
// intensity arms fit pulse and power as SEPARATE, parallel predictors of
// pace -- never against each other. This closes that gap with a direct,
// minimal bivariate check: avgHeartRateBpm ~ power, within-run fixed
// effects (same "compare a run to itself" discipline as every other
// mechanism in this file), weighted by segment duration.
//
// Deliberately a different design from hrCalibration.ts's own existing
// HR-to-effort fit (§11 stage 3), not a duplicate of it:
// - hrCalibration.ts pools raw (HR, power) pairs ACROSS races with no
//   within-run demeaning, restricted to each race's early window (cardiac
//   drift) and smoothing power over a trailing ~60-90s real-time window
//   first -- its own real-data check found that raw/unsmoothed pooling
//   underestimates the relationship (R^2 0.31 -> ~0.43 smoothed).
// - This fits WITHIN-RUN (removes each run's own baseline HR/power level,
//   the same discipline as jointSlowdownFit.ts/intensityConditionedSlowdownFit.ts),
//   at MONOTONIC-SEGMENT granularity rather than per-point. A monotonic
//   segment already spans at least ~30s/100m (monotonicSegments.ts's own
//   floor) of underlying points, so avgHeartRateBpm and avgMinettiGrossPowerWPerKg
//   are already a form of temporal averaging over that span -- this is NOT
//   the same "raw, zero-lag" comparison hrCalibration.ts's own doc warns
//   about, but it's also not identical to that module's explicit trailing-
//   window smoothing. Read this result as its own data point, not a
//   re-run of hrCalibration.ts's number.

import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { weightedLeastSquares } from "./linearSolve";

export type PowerBasis = "modelled" | "measured";

export interface SegmentPulsePowerFitResult {
  runCount: number;
  segmentCount: number;
  /** bpm change per unit of power (W/kg) -- within-run. */
  slope: number;
  /** Within-run R^2 -- how well power (of the chosen basis) explains this
   * athlete's own segment-to-segment heart rate variation. */
  rSquaredWithinRun: number;
}

function powerValue(seg: TaggedMonotonicSegment, basis: PowerBasis): number | null {
  return basis === "modelled" ? seg.avgMinettiGrossPowerWPerKg : seg.avgMeasuredPowerWPerKg;
}

/**
 * Fits avgHeartRateBpm ~ power (modelled or measured), within-run fixed
 * effects, weighted by segment duration. Restricted to running gait (walk
 * breaks are a different effort regime, same exclusion as every other fit
 * in this file). Returns null if no run contributes at least two usable
 * segments, or the resulting design is singular (a run with literally
 * constant power -- see linearSolve.ts).
 */
export function fitSegmentPulseToPower(library: TaggedMonotonicSegment[], basis: PowerBasis): SegmentPulsePowerFitResult | null {
  const usable = library.filter((s) => s.gaitMode === "run" && s.avgHeartRateBpm !== null && powerValue(s, basis) !== null);
  if (usable.length === 0) return null;

  const byRun = new Map<string, TaggedMonotonicSegment[]>();
  for (const s of usable) {
    if (!byRun.has(s.runId)) byRun.set(s.runId, []);
    byRun.get(s.runId)!.push(s);
  }

  const rowsX: number[][] = [];
  const rowsY: number[] = [];
  const rowsW: number[] = [];
  let runCount = 0;

  for (const segs of byRun.values()) {
    if (segs.length < 2) continue;

    const power = segs.map((s) => powerValue(s, basis)!);
    const hr = segs.map((s) => s.avgHeartRateBpm!);
    const w = segs.map((s) => s.timeS);

    const sumW = w.reduce((a, b) => a + b, 0);
    if (sumW <= 0) continue;
    const meanPower = power.reduce((sum, p, i) => sum + w[i] * p, 0) / sumW;
    const meanHr = hr.reduce((sum, h, i) => sum + w[i] * h, 0) / sumW;

    runCount++;
    for (let i = 0; i < segs.length; i++) {
      rowsX.push([power[i] - meanPower]);
      rowsY.push(hr[i] - meanHr);
      rowsW.push(w[i]);
    }
  }

  if (runCount === 0) return null;

  const fit = weightedLeastSquares(rowsX, rowsY, rowsW);
  if (!fit) return null;

  return {
    runCount,
    segmentCount: rowsX.length,
    slope: fit.coefficients[0],
    rSquaredWithinRun: fit.rSquared,
  };
}
