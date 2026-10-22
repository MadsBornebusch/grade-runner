import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { analyzeRun, type AnalysisResult } from "./analysis";
import { grossToNet } from "./energetics";
import { costOfRunning } from "./minetti";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { estimateVo2MaxFromRun, isEstimableEffort } from "./vo2MaxEstimate";

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    segments: [],
    totalElapsedTimeS: 40 * 60,
    totalMovingTimeS: 40 * 60,
    bonked: false,
    bonkIndex: null,
    avgEffortFraction: 1,
    raceEffortFraction: 1,
    ...overrides,
  };
}

describe("isEstimableEffort", () => {
  it("accepts durations in the 20-90 minute window", () => {
    expect(isEstimableEffort(20)).toBe(true);
    expect(isEstimableEffort(45)).toBe(true);
    expect(isEstimableEffort(90)).toBe(true);
  });

  it("rejects durations outside the window", () => {
    expect(isEstimableEffort(19)).toBe(false);
    expect(isEstimableEffort(91)).toBe(false);
    expect(isEstimableEffort(5)).toBe(false);
    expect(isEstimableEffort(8 * 60)).toBe(false);
  });
});

describe("estimateVo2MaxFromRun", () => {
  it("scales the assumed vo2max by the run's race effort fraction", () => {
    // Ran at 1.2x the ceiling predicted for an assumed vo2max of 50 ->
    // true vo2max is 50 * 1.2 = 60, regardless of duration-curve shape,
    // since that shape divides out of both the run's ceiling and the
    // assumed one identically.
    const result = estimateVo2MaxFromRun(analysis({ raceEffortFraction: 1.2 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeCloseTo(60, 6);
  });

  it("returns the assumed vo2max unchanged when effort fraction is exactly 1", () => {
    const result = estimateVo2MaxFromRun(analysis({ raceEffortFraction: 1 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeCloseTo(50, 6);
  });

  it("defaults the assumed vo2max to 50 when unset, matching ceiling.ts's own default", () => {
    const result = estimateVo2MaxFromRun(analysis({ raceEffortFraction: 1 }), {});
    expect(result).toBeCloseTo(50, 6);
  });

  it("returns null for a run shorter than the estimable window (e.g. a VO2max interval)", () => {
    const result = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: 10 * 60, raceEffortFraction: 1.3 }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    expect(result).toBeNull();
  });

  it("returns null for a run longer than the estimable window (e.g. an ultra)", () => {
    const result = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: 8 * 3600, raceEffortFraction: 0.6 }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    expect(result).toBeNull();
  });

  it("returns null when there's no usable effort signal", () => {
    const result = estimateVo2MaxFromRun(analysis({ raceEffortFraction: 0 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeNull();
  });

  it("recovers the same estimate no matter what vo2max was assumed while analyzing the run", () => {
    // The essential guarantee: ceilingPower is linear in vo2max, so the
    // duration-curve shape, altitude, and drift all divide out of
    // avgEffortFraction identically regardless of what was assumed --
    // building raceEffortFraction from the real ceilingPower function (not a
    // hand-picked number) against two different assumptions should still
    // land on the same implied true vo2max.
    const trueVo2Max = 60;
    const sharedParams: CeilingParams = { lt2Fraction: 0.85, durabilityDriftPerHour: 0.02 };
    const durationMin = 40;
    const stepMin = 5;

    function raceEffortFractionFor(assumedVo2Max: number): number {
      let weightedSum = 0;
      let weight = 0;
      for (let tMin = 0; tMin < durationMin; tMin += stepMin) {
        const input = { tMin: durationMin, altitudeM: 300, elapsedHours: tMin / 60 };
        const trueCeiling = ceilingPower(input, { ...sharedParams, vo2MaxMlPerKgPerMin: trueVo2Max });
        const assumedCeiling = ceilingPower(input, { ...sharedParams, vo2MaxMlPerKgPerMin: assumedVo2Max });
        weightedSum += (trueCeiling / assumedCeiling) * stepMin;
        weight += stepMin;
      }
      return weightedSum / weight;
    }

    const estimateFrom50 = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: durationMin * 60, raceEffortFraction: raceEffortFractionFor(50) }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    const estimateFrom70 = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: durationMin * 60, raceEffortFraction: raceEffortFractionFor(70) }),
      { vo2MaxMlPerKgPerMin: 70 },
    );

    expect(estimateFrom50).toBeCloseTo(trueVo2Max, 6);
    expect(estimateFrom70).toBeCloseTo(trueVo2Max, 6);
  });

  it("recovers the true vo2max from an evenly paced all-out run, end to end", () => {
    // 40 minutes on the flat at exactly the ceiling for a 40-minute race
    // with vo2max 55, analyzed assuming 50. Comparing against the ceiling
    // for the time elapsed so far (100% of VO2max early on) read this as
    // well under 55.
    const trueVo2Max = 55;
    const durationMin = 40;
    const dtS = 15;
    const power = ceilingPower({ tMin: durationMin, altitudeM: 0 }, { vo2MaxMlPerKgPerMin: trueVo2Max });
    const speed = grossToNet(power) / costOfRunning(0);
    const segments: CourseSegment[] = Array.from({ length: (durationMin * 60) / dtS }, (_, i) => ({
      index: i,
      cumulativeDistance3D: (i + 1) * speed * dtS,
      distanceHorizontal: speed * dtS,
      distance3D: speed * dtS,
      elevation: 0,
      gradient: 0,
      time: null,
      dtS,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
    }));
    const assumed: CeilingParams = { vo2MaxMlPerKgPerMin: 50 };
    const run = analyzeRun(segments, { bodyMassKg: 70, ceilingParams: assumed, fueling: { intakeGPerH: 60 }, glycogenStoreG: 500 });
    expect(estimateVo2MaxFromRun(run, assumed)).toBeCloseTo(trueVo2Max, 1);
    // What the old method gave for the same run.
    expect(50 * run.avgEffortFraction).toBeLessThan(trueVo2Max - 1);
  });
});
