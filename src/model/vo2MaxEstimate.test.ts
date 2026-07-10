import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "./analysis";
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
  it("scales the assumed vo2max by the run's average effort fraction", () => {
    // Ran at 1.2x the ceiling predicted for an assumed vo2max of 50 ->
    // true vo2max is 50 * 1.2 = 60, regardless of duration-curve shape,
    // since that shape divides out of both the run's ceiling and the
    // assumed one identically.
    const result = estimateVo2MaxFromRun(analysis({ avgEffortFraction: 1.2 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeCloseTo(60, 6);
  });

  it("returns the assumed vo2max unchanged when effort fraction is exactly 1", () => {
    const result = estimateVo2MaxFromRun(analysis({ avgEffortFraction: 1 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeCloseTo(50, 6);
  });

  it("defaults the assumed vo2max to 50 when unset, matching ceiling.ts's own default", () => {
    const result = estimateVo2MaxFromRun(analysis({ avgEffortFraction: 1 }), {});
    expect(result).toBeCloseTo(50, 6);
  });

  it("returns null for a run shorter than the estimable window (e.g. a VO2max interval)", () => {
    const result = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: 10 * 60, avgEffortFraction: 1.3 }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    expect(result).toBeNull();
  });

  it("returns null for a run longer than the estimable window (e.g. an ultra)", () => {
    const result = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: 8 * 3600, avgEffortFraction: 0.6 }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    expect(result).toBeNull();
  });

  it("returns null when there's no usable effort signal", () => {
    const result = estimateVo2MaxFromRun(analysis({ avgEffortFraction: 0 }), { vo2MaxMlPerKgPerMin: 50 });
    expect(result).toBeNull();
  });

  it("recovers the same estimate no matter what vo2max was assumed while analyzing the run", () => {
    // The essential guarantee: ceilingPower is linear in vo2max, so the
    // duration-curve shape, altitude, and drift all divide out of
    // avgEffortFraction identically regardless of what was assumed --
    // building avgEffortFraction from the real ceilingPower function (not a
    // hand-picked number) against two different assumptions should still
    // land on the same implied true vo2max.
    const trueVo2Max = 60;
    const sharedParams: CeilingParams = { lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250, durabilityDriftPerHour: 0.02 };
    const durationMin = 40;
    const stepMin = 5;

    function avgEffortFractionFor(assumedVo2Max: number): number {
      let weightedSum = 0;
      let weight = 0;
      for (let tMin = 0; tMin < durationMin; tMin += stepMin) {
        const input = { tMin, altitudeM: 300, elapsedHours: tMin / 60 };
        const trueCeiling = ceilingPower(input, { ...sharedParams, vo2MaxMlPerKgPerMin: trueVo2Max });
        const assumedCeiling = ceilingPower(input, { ...sharedParams, vo2MaxMlPerKgPerMin: assumedVo2Max });
        weightedSum += (trueCeiling / assumedCeiling) * stepMin;
        weight += stepMin;
      }
      return weightedSum / weight;
    }

    const estimateFrom50 = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: durationMin * 60, avgEffortFraction: avgEffortFractionFor(50) }),
      { vo2MaxMlPerKgPerMin: 50 },
    );
    const estimateFrom70 = estimateVo2MaxFromRun(
      analysis({ totalMovingTimeS: durationMin * 60, avgEffortFraction: avgEffortFractionFor(70) }),
      { vo2MaxMlPerKgPerMin: 70 },
    );

    expect(estimateFrom50).toBeCloseTo(trueVo2Max, 6);
    expect(estimateFrom70).toBeCloseTo(trueVo2Max, 6);
  });
});
