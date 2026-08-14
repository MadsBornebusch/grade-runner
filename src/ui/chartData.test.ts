import { describe, expect, it } from "vitest";
import { summarizeChartPoints, type ChartPoint } from "./chartData";

function point(overrides: Partial<ChartPoint> = {}): ChartPoint {
  return {
    distanceKm: 0,
    elevationM: 0,
    gradient: 0,
    speedMs: 3,
    mode: "run",
    glycogenG: 500,
    cumulativeTimeS: 0,
    estimatedHeartRateBpm: null,
    ...overrides,
  };
}

describe("summarizeChartPoints", () => {
  it("returns nulls for fewer than 2 points", () => {
    expect(summarizeChartPoints([])).toEqual({ avgPaceMinPerKm: null, avgGapMinPerKm: null, avgHrBpm: null });
    expect(summarizeChartPoints([point()])).toEqual({ avgPaceMinPerKm: null, avgGapMinPerKm: null, avgHrBpm: null });
  });

  it("computes avg pace as total time over total distance on a flat, constant-speed course", () => {
    // 3 m/s for 3000s -> 9km in 50 minutes -> 5.56 min/km.
    const points = [point({ distanceKm: 0, cumulativeTimeS: 0 }), point({ distanceKm: 9, cumulativeTimeS: 3000, speedMs: 3 })];
    const { avgPaceMinPerKm } = summarizeChartPoints(points);
    expect(avgPaceMinPerKm).toBeCloseTo(3000 / 60 / 9, 6);
  });

  it("GAP equals plain pace on a flat course (grade-adjustment is a no-op at grade 0)", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0, gradient: 0 }),
      point({ distanceKm: 9, cumulativeTimeS: 3000, gradient: 0, speedMs: 3 }),
    ];
    const { avgPaceMinPerKm, avgGapMinPerKm } = summarizeChartPoints(points);
    expect(avgGapMinPerKm).toBeCloseTo(avgPaceMinPerKm!, 6);
  });

  it("GAP reads faster (smaller number) than plain pace on a course run mostly uphill", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0 }),
      point({ distanceKm: 5, cumulativeTimeS: 1800, gradient: 0.1, speedMs: 5000 / 1800 }),
    ];
    const { avgPaceMinPerKm, avgGapMinPerKm } = summarizeChartPoints(points);
    expect(avgGapMinPerKm).toBeLessThan(avgPaceMinPerKm!);
  });

  it("averages estimated HR weighted by segment time, ignoring points with no estimate", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0, estimatedHeartRateBpm: null }),
      // 100s at 140bpm
      point({ distanceKm: 0.3, cumulativeTimeS: 100, estimatedHeartRateBpm: 140 }),
      // 300s at 160bpm (no estimate at this point itself, but the NEXT
      // point's own segment carries no HR either, so this middle point's
      // bpm is what the segment ENDING here contributes)
      point({ distanceKm: 1.3, cumulativeTimeS: 400, estimatedHeartRateBpm: 160 }),
    ];
    const { avgHrBpm } = summarizeChartPoints(points);
    // Segment 1 (0->100s): 140bpm, weight 100. Segment 2 (100->400s): 160bpm, weight 300.
    const expected = (140 * 100 + 160 * 300) / (100 + 300);
    expect(avgHrBpm).toBeCloseTo(expected, 6);
  });

  it("returns null avg HR when no point has an estimate", () => {
    const points = [point({ cumulativeTimeS: 0 }), point({ distanceKm: 1, cumulativeTimeS: 300 })];
    expect(summarizeChartPoints(points).avgHrBpm).toBeNull();
  });
});
