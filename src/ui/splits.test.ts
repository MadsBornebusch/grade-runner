import { describe, expect, it } from "vitest";
import type { ChartPoint } from "./chartData";
import { computeSplits } from "./splits";

function makePoint(overrides: Partial<ChartPoint>): ChartPoint {
  return {
    distanceKm: 0,
    elevationM: 0,
    gradient: 0,
    speedMs: 3,
    mode: "run",
    glycogenG: 400,
    cumulativeTimeS: 0,
    estimatedHeartRateBpm: null,
    ...overrides,
  };
}

describe("computeSplits", () => {
  it("returns an empty array for no points", () => {
    expect(computeSplits([])).toEqual([]);
  });

  it("buckets points into fixed-distance splits and sums elevation gain/loss", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.2, elevationM: 0, cumulativeTimeS: 60 }),
      makePoint({ distanceKm: 0.5, elevationM: 10, cumulativeTimeS: 150 }), // +10
      makePoint({ distanceKm: 0.9, elevationM: 5, cumulativeTimeS: 270 }), // -5
      makePoint({ distanceKm: 1.3, elevationM: 8, cumulativeTimeS: 390 }), // +3, crosses into split 2
      makePoint({ distanceKm: 1.8, elevationM: 8, cumulativeTimeS: 540 }), // +0
    ];
    const splits = computeSplits(points, 1);

    expect(splits).toHaveLength(2);
    expect(splits[0].endKm).toBeCloseTo(0.9, 6);
    expect(splits[0].elevationGainM).toBeCloseTo(10, 6);
    expect(splits[0].elevationLossM).toBeCloseTo(5, 6);
    expect(splits[0].timeS).toBe(270);
    expect(splits[1].startKm).toBeCloseTo(0.9, 6);
    expect(splits[1].endKm).toBeCloseTo(1.8, 6);
    expect(splits[1].timeS).toBe(540 - 270);
  });

  it("labels a split 'mixed' when it contains both run and walk segments", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.3, mode: "run", cumulativeTimeS: 60 }),
      makePoint({ distanceKm: 0.6, mode: "walk", cumulativeTimeS: 180 }),
    ];
    const splits = computeSplits(points, 1);
    expect(splits[0].mode).toBe("mixed");
  });

  it("labels a split with the single mode when uniform", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.3, mode: "walk", cumulativeTimeS: 60 }),
      makePoint({ distanceKm: 0.6, mode: "walk", cumulativeTimeS: 180 }),
    ];
    const splits = computeSplits(points, 1);
    expect(splits[0].mode).toBe("walk");
  });

  it("time-weights avgEstimatedHeartRateBpm across a split's points", () => {
    const points: ChartPoint[] = [
      // 60s at 150bpm, then 120s at 160bpm -- weighted mean should favor 160.
      makePoint({ distanceKm: 0.3, cumulativeTimeS: 60, estimatedHeartRateBpm: 150 }),
      makePoint({ distanceKm: 0.6, cumulativeTimeS: 180, estimatedHeartRateBpm: 160 }),
    ];
    const splits = computeSplits(points, 1);
    expect(splits[0].avgEstimatedHeartRateBpm).toBeCloseTo((150 * 60 + 160 * 120) / 180, 6);
  });

  it("is null when no point in the split has an HR estimate", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.3, cumulativeTimeS: 60 }),
      makePoint({ distanceKm: 0.6, cumulativeTimeS: 180 }),
    ];
    const splits = computeSplits(points, 1);
    expect(splits[0].avgEstimatedHeartRateBpm).toBeNull();
  });
});
