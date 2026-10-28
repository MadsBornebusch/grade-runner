import { describe, expect, it } from "vitest";
import { compactSummary, fitnessReadings, pooledPowerPerBpm, trailingIndex, type RunHrPowerSummary } from "./fitnessIndex";

/** A synthetic run: power = base + 0.1 x (hr - 140), over a few HRs. */
function run(base: number, hrs: number[]): RunHrPowerSummary {
  const samples = hrs.map((hr) => ({ hr, powerWPerKg: base + 0.1 * (hr - 140), weight: 60 }));
  const weight = samples.reduce((a, s) => a + s.weight, 0);
  return {
    meanHr: samples.reduce((a, s) => a + s.weight * s.hr, 0) / weight,
    meanPower: samples.reduce((a, s) => a + s.weight * s.powerWPerKg, 0) / weight,
    weight,
    samples,
  };
}

describe("compactSummary", () => {
  it("pools to the same slope as the full samples", () => {
    const runs = [run(10, [130, 135, 140]), run(11, [145, 150, 152])];
    const compact = runs.map(compactSummary);
    const slope = compact.reduce((a, c) => a + c.sxy, 0) / compact.reduce((a, c) => a + c.sxx, 0);
    expect(slope).toBeCloseTo(pooledPowerPerBpm(runs)!, 10);
    expect(slope).toBeCloseTo(0.1, 10);
  });
});

describe("fitnessReadings", () => {
  it("reads every run at the median HR along the pooled slope", () => {
    const runs = [run(10, [128, 132]), run(10.5, [138, 142]), run(11, [148, 152])].map((r, i) => ({ day: 100 + i, summary: compactSummary(r) }));
    const out = fitnessReadings(runs)!;
    expect(out.referenceHr).toBe(140);
    expect(out.readings.map((r) => r.value)).toEqual([expect.closeTo(10, 6), expect.closeTo(10.5, 6), expect.closeTo(11, 6)]);
  });

  it("drops runs far from the reference HR", () => {
    const runs = [run(10, [138, 142]), run(10, [139, 141]), run(10, [170, 172])].map((r, i) => ({ day: i, summary: compactSummary(r) }));
    expect(fitnessReadings(runs)!.readings).toHaveLength(2);
    expect(fitnessReadings([])).toBeNull();
  });
});

describe("trailingIndex", () => {
  it("averages the window once enough runs are in it", () => {
    const readings = [{ day: 0, value: 10 }, { day: 10, value: 11 }, { day: 20, value: 12 }, { day: 70, value: 14 }];
    expect(trailingIndex(readings, 42, 3)).toEqual([{ day: 20, value: 11 }]);
    expect(trailingIndex(readings, 80, 3).map((r) => r.value)).toEqual([11, 11.75]);
  });
});
