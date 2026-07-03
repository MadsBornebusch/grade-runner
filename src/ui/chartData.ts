import type { CourseSegment } from "../gpx/pipeline";
import type { SegmentResult } from "../model/solver";

export interface ChartPoint {
  distanceKm: number;
  elevationM: number;
  gradient: number;
  speedMs: number;
  mode: "run" | "walk";
  glycogenG: number;
  cumulativeTimeS: number;
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
    };
  });
}
