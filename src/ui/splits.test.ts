import { describe, expect, it } from "vitest";
import type { ChartPoint } from "./chartData";
import { computeCustomSplits, computeSplits } from "./splits";

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

  it("is 0 when no intakeGPerH is given (the default)", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.5, cumulativeTimeS: 150 }),
      makePoint({ distanceKm: 0.9, cumulativeTimeS: 270 }),
    ];
    const splits = computeSplits(points, 1);
    expect(splits[0].intakeCarbG).toBe(0);
    expect(splits[0].cumulativeIntakeCarbG).toBe(0);
  });

  it("computes intakeCarbG from the planned intake rate x each split's own time -- NOT total carb burned/oxidized", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.5, cumulativeTimeS: 1800 }), // 30min
      makePoint({ distanceKm: 0.9, cumulativeTimeS: 3600 }), // 1h -- last point in split 1 (<=1km)
      makePoint({ distanceKm: 1.3, cumulativeTimeS: 5400 }), // crosses into split 2
      makePoint({ distanceKm: 1.8, cumulativeTimeS: 9000 }), // 2.5h total
    ];
    // 60 g/h: split 1 spans 0->3600s (1h) -> 60g; split 2 spans 3600->9000s (1.5h) -> 90g.
    const splits = computeSplits(points, 1, 60);
    expect(splits).toHaveLength(2);
    expect(splits[0].intakeCarbG).toBeCloseTo(60, 6);
    expect(splits[0].cumulativeIntakeCarbG).toBeCloseTo(60, 6);
    expect(splits[1].intakeCarbG).toBeCloseTo(90, 6);
    expect(splits[1].cumulativeIntakeCarbG).toBeCloseTo(150, 6);
  });
});

describe("computeCustomSplits", () => {
  it("returns an empty array for no points", () => {
    expect(computeCustomSplits([], [1, 2])).toEqual([]);
  });

  it("splits at the given arbitrary distances, always ending at the course's own final point", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.5, cumulativeTimeS: 150 }),
      makePoint({ distanceKm: 1.2, cumulativeTimeS: 360 }),
      makePoint({ distanceKm: 2.4, cumulativeTimeS: 720 }),
      makePoint({ distanceKm: 3.7, cumulativeTimeS: 1110 }),
    ];
    const splits = computeCustomSplits(points, [1.2, 2.4]);
    expect(splits).toHaveLength(3);
    expect(splits[0].endKm).toBeCloseTo(1.2, 6);
    expect(splits[1].endKm).toBeCloseTo(2.4, 6);
    expect(splits[2].endKm).toBeCloseTo(3.7, 6); // final leg to the course end, not a saved point
  });

  it("ignores a saved point at or past the course end and one at or before the start", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.5, cumulativeTimeS: 150 }),
      makePoint({ distanceKm: 1.2, cumulativeTimeS: 360 }),
    ];
    const splits = computeCustomSplits(points, [0, 1.2, 5]);
    expect(splits).toHaveLength(1); // no real boundary survives -- just the one leg to the finish
    expect(splits[0].endKm).toBeCloseTo(1.2, 6);
  });

  it("deduplicates repeated saved distances instead of producing a zero-length split", () => {
    const points: ChartPoint[] = [
      makePoint({ distanceKm: 0.5, cumulativeTimeS: 150 }),
      makePoint({ distanceKm: 1.2, cumulativeTimeS: 360 }),
      makePoint({ distanceKm: 2.0, cumulativeTimeS: 600 }),
    ];
    const splits = computeCustomSplits(points, [1.0, 1.0]);
    expect(splits).toHaveLength(2);
  });
});
