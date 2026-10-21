import { describe, expect, it } from "vitest";
import type { EffortTrendPoint } from "../model/pacingFit";
import {
  pooledPowerPerBpm,
  pooledPowerPerBpmFromHrOnPower,
  powerAtReferenceHr,
  summarizeRunSamples,
  type RunHrPowerSummary,
} from "./fitnessIndex";

/** A run whose power alternates between two steady levels every 10 min,
 * with HR following power's 75 s trailing mean (as collectRaceSamples
 * smooths it): HR = hrAtZero + bpmPerPower * smoothed power, exactly.
 * 10 s points, `minutes` long. */
function run(minutes: number, powers: [number, number], hrAtZero: number, bpmPerPower: number): EffortTrendPoint[] {
  const power = Array.from({ length: minutes * 6 }, (_, i) => (Math.floor(i / 60) % 2 === 0 ? powers[0] : powers[1]));
  return power.map((p, i) => {
    const window = power.slice(Math.max(0, i - 7), i + 1); // points within 75 s
    const smoothed = window.reduce((s, x) => s + x, 0) / window.length;
    return { tHours: (i * 10) / 3600, grossPowerWPerKg: p, altitudeM: 0, dtS: 10, heartRateBpm: hrAtZero + bpmPerPower * smoothed };
  });
}

describe("fitness index", () => {
  // Same within-run relationship (8 bpm per W/kg), but the fitter run makes
  // 1 W/kg more at any HR.
  const unfit = summarizeRunSamples(run(90, [11, 12], 50, 8))!;
  const fit = summarizeRunSamples(run(90, [11.5, 12.5], 42, 8))!;

  it("recovers the within-run slope regardless of the runs' levels", () => {
    expect(pooledPowerPerBpm([unfit, fit])).toBeCloseTo(1 / 8, 6);
    expect(pooledPowerPerBpmFromHrOnPower([unfit, fit])).toBeCloseTo(1 / 8, 6);
  });

  it("reads off the level difference at a common reference HR", () => {
    const slope = pooledPowerPerBpm([unfit, fit])!;
    const ref = 145;
    expect(powerAtReferenceHr(fit, slope, ref)! - powerAtReferenceHr(unfit, slope, ref)!).toBeCloseTo(1, 6);
    expect(powerAtReferenceHr(unfit, slope, ref)).toBeCloseTo((ref - 50) / 8, 6);
  });

  it("gives no index far from the run's own HR or without enough samples", () => {
    const summary: RunHrPowerSummary = { meanHr: 120, meanPower: 10, weight: 3600, samples: [] };
    expect(powerAtReferenceHr(summary, 0.1, 145)).toBeNull();
    expect(summarizeRunSamples(run(25, [11, 12], 50, 8))).toBeNull(); // 25 min, minus the 15 min start trim
  });
});
