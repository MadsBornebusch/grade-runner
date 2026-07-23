import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { costOfRunning, costOfWalking } from "./minetti";
import { netToGross } from "./energetics";
import { maxAerobicPower } from "./ceiling";
import { hardWorkJPerKg, netLocomotionWorkJPerKg, workStepForSegment } from "./workAccumulation";

/** Mirrors monotonicSegments.test.ts's own seg() helper. */
function seg(overrides: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: 50,
    distance3D: 50,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: 25,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...overrides,
  };
}

describe("workStepForSegment", () => {
  it("computes net work as Minetti running cost times distance on a running-gait segment", () => {
    const s = seg({ distance3D: 100, dtS: 20, gradient: 0.05 }); // 5 m/s, running gait
    const step = workStepForSegment(s);
    const expectedCost = costOfRunning(0.05);
    expect(step.netWorkJPerKg).toBeCloseTo(expectedCost * 100, 6);
    expect(step.grossPowerWPerKg).toBeCloseTo(netToGross(expectedCost * 5), 6);
  });

  it("uses walking cost instead of running cost below the walkMaxMs threshold", () => {
    const s = seg({ distance3D: 30, dtS: 20, gradient: 0.1 }); // 1.5 m/s, walking gait
    const step = workStepForSegment(s, {}, 2.0);
    const expectedCost = costOfWalking(0.1);
    expect(step.netWorkJPerKg).toBeCloseTo(expectedCost * 30, 6);
  });

  it("returns zero for a paused segment", () => {
    const step = workStepForSegment(seg({ paused: true }));
    expect(step).toEqual({ netWorkJPerKg: 0, hardWorkJPerKg: 0, grossPowerWPerKg: 0 });
  });

  it("returns zero for an untimed segment", () => {
    const step = workStepForSegment(seg({ dtS: null }));
    expect(step).toEqual({ netWorkJPerKg: 0, hardWorkJPerKg: 0, grossPowerWPerKg: 0 });
  });

  it("reports zero hard work when gross power is at or below the LT2 threshold", () => {
    const s = seg({ distance3D: 50, dtS: 50, gradient: 0 }); // gentle 1 m/s jog
    const step = workStepForSegment(s, { vo2MaxMlPerKgPerMin: 80 }); // generous LT2 headroom
    expect(step.hardWorkJPerKg).toBe(0);
  });

  it("reports positive hard work above LT2, scaling with excess power and duration", () => {
    const s = seg({ distance3D: 300, dtS: 60, gradient: 0.15 }); // fast, steep -- well above LT2
    const ceilingParams = { vo2MaxMlPerKgPerMin: 40 }; // low VO2max -> low LT2 threshold
    const step = workStepForSegment(s, ceilingParams);
    const grossPowerWPerKg = netToGross(costOfRunning(0.15) * 5);
    const lt2Power = maxAerobicPower(s.elevation, ceilingParams) * 0.85;
    expect(step.hardWorkJPerKg).toBeCloseTo(Math.max(0, grossPowerWPerKg - lt2Power) * 60, 6);
    expect(step.hardWorkJPerKg).toBeGreaterThan(0);
  });

  it("respects a custom lt2Fraction", () => {
    const s = seg({ distance3D: 300, dtS: 60, gradient: 0.15 });
    const lenient = workStepForSegment(s, { vo2MaxMlPerKgPerMin: 40, lt2Fraction: 0.95 });
    const strict = workStepForSegment(s, { vo2MaxMlPerKgPerMin: 40, lt2Fraction: 0.5 });
    expect(strict.hardWorkJPerKg).toBeGreaterThan(lenient.hardWorkJPerKg);
  });
});

describe("netLocomotionWorkJPerKg / hardWorkJPerKg (whole-array reducers)", () => {
  it("sums per-segment net work across an array, skipping paused segments", () => {
    const segments = [
      seg({ index: 0, distance3D: 100, dtS: 20, gradient: 0.05 }),
      seg({ index: 1, paused: true, distance3D: 0, dtS: 25 }),
      seg({ index: 2, distance3D: 100, dtS: 20, gradient: 0.05 }),
    ];
    const total = netLocomotionWorkJPerKg(segments);
    const perSegment = costOfRunning(0.05) * 100;
    expect(total).toBeCloseTo(perSegment * 2, 6);
  });

  it("matches summing workStepForSegment directly, segment by segment", () => {
    const segments = [
      seg({ index: 0, distance3D: 120, dtS: 30, gradient: 0.08 }),
      seg({ index: 1, distance3D: 40, dtS: 30, gradient: -0.1 }),
      seg({ index: 2, distance3D: 300, dtS: 60, gradient: 0.2 }),
    ];
    const ceilingParams = { vo2MaxMlPerKgPerMin: 45 };
    const expectedNet = segments.reduce((sum, s) => sum + workStepForSegment(s, ceilingParams).netWorkJPerKg, 0);
    const expectedHard = segments.reduce((sum, s) => sum + workStepForSegment(s, ceilingParams).hardWorkJPerKg, 0);
    expect(netLocomotionWorkJPerKg(segments, ceilingParams)).toBeCloseTo(expectedNet, 6);
    expect(hardWorkJPerKg(segments, ceilingParams)).toBeCloseTo(expectedHard, 6);
  });

  it("returns zero for an empty array", () => {
    expect(netLocomotionWorkJPerKg([])).toBe(0);
    expect(hardWorkJPerKg([])).toBe(0);
  });
});
