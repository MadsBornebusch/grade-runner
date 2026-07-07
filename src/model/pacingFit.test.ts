import { describe, expect, it } from "vitest";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { fitDurabilityDriftPerHour, fitTauMinutes, trimForPacingFit } from "./pacingFit";

/** Builds points where actual power is a constant fraction of the ceiling
 * computed under `trueParams` -- i.e. a run that held perfectly even effort
 * relative to that fade shape, sampled every `stepMinutes`. */
function makeConstantEffortPoints(
  trueParams: CeilingParams,
  totalHours: number,
  stepMinutes = 5,
  effortLevel = 1.0,
) {
  const points = [];
  const stepHours = stepMinutes / 60;
  for (let t = 0; t < totalHours; t += stepHours) {
    const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, trueParams);
    points.push({ tHours: t, grossPowerWPerKg: ceiling * effortLevel, altitudeM: 0, dtS: stepMinutes * 60 });
  }
  return points;
}

describe("trimForPacingFit", () => {
  it("drops points within the trim window at both ends", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      tHours: i * 0.5, // 0 to 9.5h
      grossPowerWPerKg: 3,
      altitudeM: 0,
      dtS: 1800,
    }));
    const trimmed = trimForPacingFit(points);
    expect(trimmed[0].tHours).toBeGreaterThan(0);
    expect(trimmed[trimmed.length - 1].tHours).toBeLessThan(9.5);
  });
});

describe("fitTauMinutes", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38 };

  it("recovers a tau close to the true fade shape when effort was held constant relative to it", () => {
    const trueTau = 120;
    const points = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 6);
    // "Currently configured" ceilingParams assumes a much slower fade than reality.
    const assumedParams = { ...baseParams, tauMin: 400 };
    const result = fitTauMinutes(points, assumedParams);
    expect(result).not.toBeNull();
    expect(result!.tauMin).toBeGreaterThan(90);
    expect(result!.tauMin).toBeLessThan(150);
    expect(Math.abs(result!.trendAtFitPctPerHour)).toBeLessThan(Math.abs(result!.trendAtCurrentPctPerHour));
  });

  it("reports ~0 residual trend at the fitted tau", () => {
    const points = makeConstantEffortPoints({ ...baseParams, tauMin: 90 }, 5);
    const result = fitTauMinutes(points, { ...baseParams, tauMin: 400 });
    expect(result).not.toBeNull();
    expect(Math.abs(result!.trendAtFitPctPerHour)).toBeLessThan(1);
  });

  it("returns null when too few points survive trimming", () => {
    const points = makeConstantEffortPoints(baseParams, 0.1, 1);
    expect(fitTauMinutes(points, baseParams)).toBeNull();
  });

  it("returns null with no points", () => {
    expect(fitTauMinutes([], baseParams)).toBeNull();
  });

  it("scales the search range up for a very long race instead of clipping at a short-race constant", () => {
    // Regression guard: an earlier version capped the upper bound at a flat
    // 600 minutes regardless of race length, so anything past ~4h always
    // hit that ceiling instead of a duration-scaled one. A 26h race with a
    // genuinely long (1800 min) fade should still be recoverable, not
    // clipped to 600.
    const trueTau = 1800;
    const points = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 26, 15);
    const result = fitTauMinutes(points, { ...baseParams, tauMin: 250 });
    expect(result).not.toBeNull();
    expect(result!.tauMin).toBeGreaterThan(1500);
    expect(result!.hitSearchBoundary).toBeNull();
  });
});

describe("fitDurabilityDriftPerHour", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

  it("recovers a drift rate that flattens a genuinely downward effort trend", () => {
    // Drift can only ever shrink the modeled ceiling further over time, so it
    // can only flatten a DOWNWARD-trending ratio (apparent fatigue beyond
    // what tau/f0/fInf already model) -- not the upward trend this app's
    // actual bug report was about. Construct that downward case directly.
    const trueDrift = 0.03;
    const points = [];
    for (let t = 0.2; t < 5; t += 0.1) {
      const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, baseParams);
      points.push({ tHours: t, grossPowerWPerKg: ceiling * (1 - trueDrift * t), altitudeM: 0, dtS: 360 });
    }
    const result = fitDurabilityDriftPerHour(points, baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerHour).toBeGreaterThan(0.02);
    expect(result!.durabilityDriftPerHour).toBeLessThan(0.04);
    expect(Math.abs(result!.trendAtFitPctPerHour)).toBeLessThan(1);
  });

  it("cannot flatten an upward trend -- residual stays upward even at the fit", () => {
    // The mirror-image case: effort trends upward (actual power outpaced the
    // ceiling's decay). Adding drift only shrinks the ceiling further, which
    // makes an upward ratio worse, not better -- so the best-fit drift should
    // land at (or near) the lower bound of its search range, not "fix" it.
    const points = makeConstantEffortPoints({ ...baseParams, tauMin: 600 }, 5);
    const result = fitDurabilityDriftPerHour(points, { ...baseParams, tauMin: 120 });
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerHour).toBeCloseTo(0, 2);
  });
});
