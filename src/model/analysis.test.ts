import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { analyzeRun, type AnalysisInputs } from "./analysis";

function makeSegment(overrides: Partial<CourseSegment>): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 50,
    distanceHorizontal: 50,
    distance3D: 50,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: 15, // 50m in 15s => ~3.33 m/s, a running pace
    paused: false,
    ...overrides,
  };
}

function baseInputs(overrides: Partial<AnalysisInputs> = {}): AnalysisInputs {
  return {
    bodyMassKg: 70,
    fueling: { intakeGPerH: 60, gutMaxGPerH: 60 },
    glycogenStoreG: 500,
    reserveG: 60,
    ...overrides,
  };
}

function makeRunningSegments(n: number): CourseSegment[] {
  let cumulative = 0;
  return Array.from({ length: n }, (_, i) => {
    cumulative += 50;
    return makeSegment({ index: i, cumulativeDistance3D: cumulative });
  });
}

describe("analyzeRun", () => {
  it("reconstructs speed from distance/dtS", () => {
    const result = analyzeRun(makeRunningSegments(1), baseInputs());
    expect(result.segments[0].speedMs).toBeCloseTo(50 / 15, 6);
  });

  it("skips segments with no timestamp data", () => {
    const segments = [makeSegment({ dtS: null }), makeSegment({ index: 1, dtS: 15 })];
    const result = analyzeRun(segments, baseInputs());
    expect(result.segments).toHaveLength(1);
  });

  it("costs paused segments at resting metabolism with zero speed", () => {
    const segments = [makeSegment({ paused: true, dtS: 60 })];
    const result = analyzeRun(segments, baseInputs());
    expect(result.segments[0].speedMs).toBe(0);
    expect(result.segments[0].grossPowerWPerKg).toBeCloseTo(1.2, 6);
  });

  it("excludes paused time from moving time but includes it in elapsed time", () => {
    const segments = [
      makeSegment({ index: 0, paused: false, dtS: 15 }),
      makeSegment({ index: 1, paused: true, dtS: 60, cumulativeDistance3D: 100 }),
    ];
    const result = analyzeRun(segments, baseInputs());
    expect(result.totalElapsedTimeS).toBe(75);
    expect(result.totalMovingTimeS).toBe(15);
  });

  it("accumulates carb and fat grams monotonically", () => {
    const result = analyzeRun(makeRunningSegments(5), baseInputs());
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].cumulativeCarbG).toBeGreaterThanOrEqual(result.segments[i - 1].cumulativeCarbG);
      expect(result.segments[i].cumulativeFatG).toBeGreaterThanOrEqual(result.segments[i - 1].cumulativeFatG);
    }
  });

  it("flags a bonk when glycogen depletes below reserve, but keeps going through the whole run", () => {
    const segments = makeRunningSegments(2000); // 100km at ~3.3 m/s
    const result = analyzeRun(
      segments,
      baseInputs({ fueling: { intakeGPerH: 0, gutMaxGPerH: 0 }, glycogenStoreG: 250 }),
    );
    expect(result.bonked).toBe(true);
    expect(result.bonkIndex).not.toBeNull();
    // unlike the planning solver, analysis reconstructs the whole recorded run
    expect(result.segments).toHaveLength(2000);
  });

  it("reports no bonk when fueling comfortably covers the observed effort", () => {
    const segments = makeRunningSegments(20);
    const result = analyzeRun(segments, baseInputs());
    expect(result.bonked).toBe(false);
    expect(result.bonkIndex).toBeNull();
  });
});
