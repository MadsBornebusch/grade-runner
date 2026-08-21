import type { CourseSegment } from "../gpx/pipeline";
import type { AnalysisSegmentResult } from "../model/analysis";
import { type HrPowerCalibration, predictHeartRateFromPower } from "../model/hrCalibration";
import { gradeAdjustedSpeedMs } from "../model/minetti";
import type { SegmentResult } from "../model/solver";

export interface ChartPoint {
  distanceKm: number;
  elevationM: number;
  gradient: number;
  speedMs: number;
  mode: "run" | "walk";
  glycogenG: number;
  cumulativeTimeS: number;
  /** Undefined when no surface classification is available for this point
   * at all (see CourseSegment.surfaceUnpaved's own doc) -- distinct from
   * false ("known paved"), so a course with no surface data doesn't render
   * as if it were entirely paved. */
  surfaceUnpaved?: boolean;
  /** Heart rate this athlete would likely show at this point's gross
   * power, via their own fitted HR-power calibration (PLAN.md §11 stage 3)
   * -- null when no calibration is applied. A rough estimate, not a
   * recording: useful for Planning mode, where there's no real HR to show
   * yet. */
  estimatedHeartRateBpm: number | null;
}

/** Shared by both builders below -- estimates HR from this point's own
 * gross power, inverting the athlete's fitted calibration. Returns null
 * without a calibration applied, matching every other "no data" convention
 * in this codebase (undefined/null, never a silent 0 or default). */
export interface HrEstimateInputs {
  calibration: HrPowerCalibration;
}

function estimateHeartRateBpm(grossPowerWPerKg: number, hrEstimateInputs: HrEstimateInputs | undefined): number | null {
  if (!hrEstimateInputs) return null;
  return predictHeartRateFromPower(grossPowerWPerKg, hrEstimateInputs.calibration);
}

/** Merges solver output back with the original course segments (for
 * elevation/gradient, which the solver doesn't carry) into one series. */
export function buildChartPoints(
  courseSegments: CourseSegment[],
  results: SegmentResult[],
  hrEstimateInputs?: HrEstimateInputs,
): ChartPoint[] {
  return results.map((r) => {
    const seg = courseSegments[r.index];
    return {
      distanceKm: r.cumulativeDistance3D / 1000,
      elevationM: seg?.elevation ?? 0,
      gradient: seg?.gradient ?? 0,
      speedMs: r.speedMs,
      mode: r.mode,
      glycogenG: r.glycogenG,
      cumulativeTimeS: r.cumulativeTimeS,
      surfaceUnpaved: seg?.surfaceUnpaved,
      estimatedHeartRateBpm: estimateHeartRateBpm(r.grossPowerWPerKg, hrEstimateInputs),
    };
  });
}

/** Same shape as buildChartPoints, for analysis mode's reconstructed run.
 * cumulativeTimeS is elapsed (not moving) time, so it includes pauses --
 * the same convention a wall-clock split table should use. Mode is inferred
 * from the same speed threshold analyzeRun used to pick a cost curve. */
export function buildAnalysisChartPoints(
  courseSegments: CourseSegment[],
  results: AnalysisSegmentResult[],
  walkMaxMs = 2.0,
  hrEstimateInputs?: HrEstimateInputs,
): ChartPoint[] {
  return results.map((r) => {
    const seg = courseSegments[r.index];
    return {
      distanceKm: r.cumulativeDistance3D / 1000,
      elevationM: seg?.elevation ?? 0,
      gradient: seg?.gradient ?? 0,
      speedMs: r.speedMs,
      mode: r.speedMs <= walkMaxMs ? "walk" : "run",
      glycogenG: r.glycogenG,
      cumulativeTimeS: r.cumulativeElapsedTimeS,
      surfaceUnpaved: seg?.surfaceUnpaved,
      estimatedHeartRateBpm: estimateHeartRateBpm(r.grossPowerWPerKg, hrEstimateInputs),
    };
  });
}

export interface CourseSummaryStats {
  avgPaceMinPerKm: number | null;
  /** Grade-adjusted pace: the flat-equivalent pace for the same overall
   * effort, aggregated by summing each segment's own flat-equivalent time
   * (distance / gradeAdjustedSpeedMs) rather than averaging per-segment GAP
   * values directly -- pace is a rate, so a plain arithmetic mean across
   * unequal segments would be subtly wrong (a harmonic-style, time-based
   * aggregation is what "how fast would the WHOLE course have felt on
   * flat ground" actually asks for). */
  avgGapMinPerKm: number | null;
  /** Time-weighted mean of estimatedHeartRateBpm, skipping points with none
   * (no calibration applied) -- null if no point has an estimate at all. */
  avgHrBpm: number | null;
}

/** Summarizes a course/effort's chart points into whole-course averages --
 * pace, grade-adjusted pace (GAP), and estimated heart rate. Needs at least
 * 2 points (a single point has no distance/time to weight against). */
export function summarizeChartPoints(points: ChartPoint[]): CourseSummaryStats {
  if (points.length < 2) return { avgPaceMinPerKm: null, avgGapMinPerKm: null, avgHrBpm: null };

  const totalDistanceKm = points[points.length - 1].distanceKm - points[0].distanceKm;
  const totalTimeS = points[points.length - 1].cumulativeTimeS - points[0].cumulativeTimeS;
  const avgPaceMinPerKm = totalDistanceKm > 0 ? totalTimeS / 60 / totalDistanceKm : null;

  let totalGapTimeS = 0;
  let hrWeightedSum = 0;
  let hrWeight = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segDistanceM = (cur.distanceKm - prev.distanceKm) * 1000;
    const segTimeS = cur.cumulativeTimeS - prev.cumulativeTimeS;
    if (segDistanceM > 0 && cur.speedMs > 0) {
      const gapSpeedMs = gradeAdjustedSpeedMs(cur.speedMs, cur.gradient, cur.mode);
      totalGapTimeS += gapSpeedMs > 0 ? segDistanceM / gapSpeedMs : 0;
    }
    if (cur.estimatedHeartRateBpm !== null && segTimeS > 0) {
      hrWeightedSum += cur.estimatedHeartRateBpm * segTimeS;
      hrWeight += segTimeS;
    }
  }

  return {
    avgPaceMinPerKm,
    avgGapMinPerKm: totalDistanceKm > 0 ? totalGapTimeS / 60 / totalDistanceKm : null,
    avgHrBpm: hrWeight > 0 ? hrWeightedSum / hrWeight : null,
  };
}
