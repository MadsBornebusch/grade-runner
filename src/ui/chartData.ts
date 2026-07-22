import type { CourseSegment } from "../gpx/pipeline";
import type { AnalysisSegmentResult } from "../model/analysis";
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
}

/** Merges solver output back with the original course segments (for
 * elevation/gradient, which the solver doesn't carry) into one series. */
export function buildChartPoints(
  courseSegments: CourseSegment[],
  results: SegmentResult[],
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
    };
  });
}
