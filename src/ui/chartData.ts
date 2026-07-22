import type { CourseSegment } from "../gpx/pipeline";
import type { AnalysisSegmentResult } from "../model/analysis";
import { type CeilingParams, ceilingPower } from "../model/ceiling";
import { type HrEffortCalibration, predictHeartRateFromEffortFraction } from "../model/hrCalibration";
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
  /** Heart rate this athlete would likely show at this point's effort
   * fraction, via their own fitted HR-effort calibration (PLAN.md §11
   * stage 3) -- null when no calibration is applied, or the ceiling at
   * this point is non-positive. A rough estimate, not a recording: useful
   * for Planning mode, where there's no real HR to show yet. */
  estimatedHeartRateBpm: number | null;
}

/** Shared by both builders below -- estimates HR from this point's own
 * effortFraction (grossPower over the ceiling at this point in time),
 * inverting the athlete's fitted calibration. Returns null without a
 * calibration applied, matching every other "no data" convention in this
 * codebase (undefined/null, never a silent 0 or default). */
export interface HrEstimateInputs {
  ceilingParams: CeilingParams;
  calibration: HrEffortCalibration;
  altitudeAdjustment: boolean;
}

function estimateHeartRateBpm(
  grossPowerWPerKg: number,
  tHours: number,
  altitudeM: number,
  hrEstimateInputs: HrEstimateInputs | undefined,
): number | null {
  if (!hrEstimateInputs) return null;
  const ceiling = ceilingPower(
    { tMin: tHours * 60, altitudeM: hrEstimateInputs.altitudeAdjustment ? altitudeM : 0, elapsedHours: tHours },
    hrEstimateInputs.ceilingParams,
  );
  if (ceiling <= 0) return null;
  return predictHeartRateFromEffortFraction(grossPowerWPerKg / ceiling, hrEstimateInputs.calibration);
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
    const tHours = (r.cumulativeTimeS - r.timeS) / 3600;
    return {
      distanceKm: r.cumulativeDistance3D / 1000,
      elevationM: seg?.elevation ?? 0,
      gradient: seg?.gradient ?? 0,
      speedMs: r.speedMs,
      mode: r.mode,
      glycogenG: r.glycogenG,
      cumulativeTimeS: r.cumulativeTimeS,
      surfaceUnpaved: seg?.surfaceUnpaved,
      estimatedHeartRateBpm: estimateHeartRateBpm(r.grossPowerWPerKg, tHours, seg?.elevation ?? 0, hrEstimateInputs),
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
    const tHours = (r.cumulativeElapsedTimeS - r.timeS) / 3600;
    return {
      distanceKm: r.cumulativeDistance3D / 1000,
      elevationM: seg?.elevation ?? 0,
      gradient: seg?.gradient ?? 0,
      speedMs: r.speedMs,
      mode: r.speedMs <= walkMaxMs ? "walk" : "run",
      glycogenG: r.glycogenG,
      cumulativeTimeS: r.cumulativeElapsedTimeS,
      surfaceUnpaved: seg?.surfaceUnpaved,
      estimatedHeartRateBpm: estimateHeartRateBpm(r.grossPowerWPerKg, tHours, seg?.elevation ?? 0, hrEstimateInputs),
    };
  });
}
