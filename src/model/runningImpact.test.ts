import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { costOfRunning } from "./minetti";
import { DEFAULT_RUNNING_IMPACT_COEFFICIENTS, hillSurchargeKm, runningImpact } from "./runningImpact";

function segment(overrides: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: 1000,
    distance3D: 1000,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: null,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...overrides,
  };
}

describe("hillSurchargeKm", () => {
  it("is zero on a perfectly flat course", () => {
    const segments = [segment({ gradient: 0 }), segment({ gradient: 0 })];
    expect(hillSurchargeKm(segments)).toBe(0);
  });

  it("is positive on a climbing course", () => {
    const segments = [segment({ gradient: 0.1, distanceHorizontal: 1000 })];
    const expected = (1000 * (costOfRunning(0.1) / costOfRunning(0)) - 1000) / 1000;
    expect(hillSurchargeKm(segments)).toBeCloseTo(expected, 9);
    expect(hillSurchargeKm(segments)).toBeGreaterThan(0);
  });

  it("goes negative on a gentle descent, where running is metabolically cheaper than flat", () => {
    expect(costOfRunning(-0.08)).toBeLessThan(costOfRunning(0)); // sanity check on the underlying curve
    const segments = [segment({ gradient: -0.08, distanceHorizontal: 1000 })];
    expect(hillSurchargeKm(segments)).toBeLessThan(0);
  });

  it("sums independently per segment, regardless of order", () => {
    const a = segment({ gradient: 0.1, distanceHorizontal: 500 });
    const b = segment({ gradient: -0.05, distanceHorizontal: 500 });
    expect(hillSurchargeKm([a, b])).toBeCloseTo(hillSurchargeKm([b, a]), 9);
  });
});

describe("runningImpact", () => {
  it("reduces to distanceCoefficient x distance on a flat course", () => {
    const segments = [segment({ gradient: 0, distanceHorizontal: 5000, cumulativeDistance3D: 5000 })];
    expect(runningImpact(segments)).toBeCloseTo(5 * DEFAULT_RUNNING_IMPACT_COEFFICIENTS.distanceCoefficient, 6);
  });

  it("scores a hilly course higher than an equal-distance flat one", () => {
    const flat = [segment({ gradient: 0, distanceHorizontal: 5000, cumulativeDistance3D: 5000 })];
    const hilly = [segment({ gradient: 0.1, distanceHorizontal: 5000, cumulativeDistance3D: 5000 })];
    expect(runningImpact(hilly)).toBeGreaterThan(runningImpact(flat));
  });

  it("honors custom coefficients instead of the fitted defaults", () => {
    const segments = [segment({ gradient: 0, distanceHorizontal: 2000, cumulativeDistance3D: 2000 })];
    expect(runningImpact(segments, { distanceCoefficient: 10, hillSurchargeCoefficient: 0 })).toBeCloseTo(20, 6);
  });

  it("reads total distance from the last segment's cumulativeDistance3D, not a per-segment sum", () => {
    const segments = [
      segment({ distanceHorizontal: 1000, cumulativeDistance3D: 1000 }),
      segment({ distanceHorizontal: 1000, cumulativeDistance3D: 2000 }),
    ];
    expect(runningImpact(segments)).toBeCloseTo(2 * DEFAULT_RUNNING_IMPACT_COEFFICIENTS.distanceCoefficient, 6);
  });
});
