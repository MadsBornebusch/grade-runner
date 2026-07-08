import { describe, expect, it } from "vitest";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { fitDurabilityDriftPerHour, fitTauAcrossRaces, fitTauMinutes, trimForPacingFit } from "./pacingFit";

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

describe("fitTauAcrossRaces", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38 };

  it("recovers a shared true tau from two races of different lengths", () => {
    const trueTau = 150;
    const raceA = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 4);
    const raceB = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 7);
    const result = fitTauAcrossRaces([raceA, raceB], { ...baseParams, tauMin: 400 });
    expect(result).not.toBeNull();
    expect(result!.tauMin).toBeGreaterThan(120);
    expect(result!.tauMin).toBeLessThan(180);
    expect(result!.perRace).toHaveLength(2);
    for (const race of result!.perRace) {
      expect(Math.abs(race.trendAtFitPctPerHour)).toBeLessThan(Math.abs(race.trendAtCurrentPctPerHour));
    }
  });

  it("ignores a race with too few points and still fits from the rest", () => {
    const trueTau = 150;
    const goodRace = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 6);
    const tooShort = makeConstantEffortPoints(baseParams, 0.1, 1);
    const result = fitTauAcrossRaces([goodRace, tooShort], { ...baseParams, tauMin: 400 });
    expect(result).not.toBeNull();
    expect(result!.perRace).toHaveLength(1);
  });

  it("returns null when no race has enough points", () => {
    const tooShort = makeConstantEffortPoints(baseParams, 0.1, 1);
    expect(fitTauAcrossRaces([tooShort], baseParams)).toBeNull();
  });

  it("scales the range from the shortest and longest race in the set, not a flat constant", () => {
    const trueTau = 1800;
    const shortRace = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 3, 5);
    const longRace = makeConstantEffortPoints({ ...baseParams, tauMin: trueTau }, 26, 15);
    const result = fitTauAcrossRaces([shortRace, longRace], { ...baseParams, tauMin: 250 });
    expect(result).not.toBeNull();
    expect(result!.tauMin).toBeGreaterThan(1500);
  });

  /** Raw power trending at a fixed rate off some base level -- not a clean
   * match to any single ceiling shape, more like real GPS/power data. */
  function makeRealisticRace(totalMinutes: number, baseLevel: number, trendPerHour: number, stepMinutes = 5) {
    const points = [];
    const refCeiling = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, baseParams);
    for (let t = 0; t < totalMinutes; t += stepMinutes) {
      const hours = t / 60;
      points.push({ tHours: hours, grossPowerWPerKg: refCeiling * (baseLevel + trendPerHour * hours), altitudeM: 0, dtS: stepMinutes * 60 });
    }
    return points;
  }

  describe("unresponsive flag", () => {
    it("flags races too short to leave the LT2 cap at the fitted tau, not the long ones pooled alongside them", () => {
      // Regression case for the actual bug report: a 10k and a 35k pooled
      // with an 80k and a 16h backyard ultra. Real distances/paces varied
      // here (50/270/660/960 min) with modest, differing raw-power trends --
      // the two short ones should never be able to leave the LT2-capped
      // plateau at whatever tau the pooled search lands on, unlike the two
      // long ones.
      const race50 = makeRealisticRace(50, 0.8, -0.1, 2);
      const race270 = makeRealisticRace(270, 0.75, -0.02);
      const race660 = makeRealisticRace(660, 0.7, 0.01);
      const race960 = makeRealisticRace(960, 0.65, 0.008);

      const result = fitTauAcrossRaces([race50, race270, race660, race960], { ...baseParams, tauMin: 250 });
      expect(result).not.toBeNull();
      expect(result!.perRace).toHaveLength(4);
      expect(result!.perRace[0].unresponsive).toBe(true);
      expect(result!.perRace[1].unresponsive).toBe(true);
      expect(result!.perRace[2].unresponsive).toBe(false);
      expect(result!.perRace[3].unresponsive).toBe(false);
    });

    it("does not flag a clean two-race case where both races genuinely inform the fit", () => {
      const race700 = makeConstantEffortPoints({ ...baseParams, tauMin: 700 }, 700 / 60);
      const race600 = makeConstantEffortPoints({ ...baseParams, tauMin: 600 }, 600 / 60);
      const result = fitTauAcrossRaces([race700, race600], { ...baseParams, tauMin: 250 });
      expect(result).not.toBeNull();
      expect(result!.perRace[0].unresponsive).toBe(false);
      expect(result!.perRace[1].unresponsive).toBe(false);
    });
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
