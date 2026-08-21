import { describe, expect, it } from "vitest";
import { ceilingPower, type CeilingParams } from "./ceiling";
import type { HrPowerCalibration } from "./hrCalibration";
import type { EffortTrendPoint } from "./pacingFit";
import {
  computeChosenTheta,
  fitPacingMarginAcrossRaces,
  MIN_MARGIN_FIT_RACES,
  predictBestDemonstratedTheta,
  predictMarginTheta,
  type PacingMarginFitResult,
} from "./pacingMarginFit";

const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

// slope=1, intercept=0 -> predictPowerFromHr(hr, calib) === hr, so a race's
// own recorded "heart rate" can just BE the target power (in whatever units
// keep the fixtures readable) directly -- computeChosenTheta still divides
// by the real per-point ceiling to get theta, so the fixture builder below
// bakes that division in when choosing heartRateBpm, keeping each race's
// theta constant across its own early window despite the ceiling itself
// decaying with elapsed time.
const identityCalibration: HrPowerCalibration = { slope: 1, intercept: 0, rSquared: 1, pointCount: 100, raceCount: 10 };

/** Builds a race that holds a constant chosen theta (via identityCalibration,
 * heartRateBpm === targetTheta * ceilingPower(tHours)) across its own early
 * window, then jumps to a very different value for the tail -- lets tests
 * confirm computeChosenTheta actually restricts to the early window instead
 * of averaging the whole race. The switch happens at 80% of total duration
 * -- comfortably PAST EARLY_WINDOW_FRACTION's 65% cutoff (with margin, so
 * float rounding at the actual boundary can't misclassify a point) while
 * still leaving a real late-window tail to prove it gets excluded. */
function makeConstantEffortRace(totalHours: number, earlyTheta: number, lateTheta = 0.05): EffortTrendPoint[] {
  const stepHours = totalHours / 40;
  const points: EffortTrendPoint[] = [];
  for (let t = 0; t < totalHours; t += stepHours) {
    const theta = t / totalHours < 0.8 ? earlyTheta : lateTheta;
    const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, baseParams);
    points.push({ tHours: t, grossPowerWPerKg: theta * ceiling, altitudeM: 0, dtS: stepHours * 3600, heartRateBpm: theta * ceiling });
  }
  return points;
}

describe("computeChosenTheta", () => {
  it("recovers the early-window chosen theta, ignoring the late-window jump", () => {
    const race = makeConstantEffortRace(4, 0.7);
    expect(computeChosenTheta(race, identityCalibration, baseParams)).toBeCloseTo(0.7, 3);
  });

  it("returns null for an empty race", () => {
    expect(computeChosenTheta([], identityCalibration, baseParams)).toBeNull();
  });

  it("returns null when no point in the early window has heart rate data", () => {
    const race = makeConstantEffortRace(4, 0.7).map((p) => ({ ...p, heartRateBpm: undefined }));
    expect(computeChosenTheta(race, identityCalibration, baseParams)).toBeNull();
  });
});

describe("fitPacingMarginAcrossRaces", () => {
  function marginTheta(durationHours: number, marginFInf: number, marginTauHours: number): number {
    return marginFInf + (1 - marginFInf) * Math.exp(-durationHours / marginTauHours);
  }

  it("returns null with fewer than MIN_MARGIN_FIT_RACES usable races", () => {
    const races = Array.from({ length: MIN_MARGIN_FIT_RACES - 1 }, (_, i) => makeConstantEffortRace(1 + i, 0.8));
    const names = races.map((_, i) => `race ${i}`);
    expect(fitPacingMarginAcrossRaces(races, names, identityCalibration, baseParams)).toBeNull();
  });

  it("recovers known (marginFInf, marginTauHours) from noise-free synthetic races", () => {
    const trueFInf = 0.6;
    const trueTau = 5;
    const durations = [0.5, 1, 2, 4, 8, 16, 24];
    const races = durations.map((h) => makeConstantEffortRace(h, marginTheta(h, trueFInf, trueTau)));
    const names = durations.map((h) => `${h}h race`);
    const result = fitPacingMarginAcrossRaces(races, names, identityCalibration, baseParams);
    expect(result).not.toBeNull();
    expect(result!.marginFInf).toBeCloseTo(trueFInf, 1);
    expect(result!.marginTauHours).toBeCloseTo(trueTau, 0);
    expect(result!.raceCount).toBe(durations.length);
    expect(result!.minDurationHours).toBeCloseTo(0.5, 6);
    expect(result!.maxDurationHours).toBeCloseTo(24, 6);
    // Noise-free recovery -> every race sits almost exactly on its own
    // fitted curve, so the best-demonstrated upside is ~0.
    expect(result!.bestUpsideOffset).toBeLessThan(0.02);
  });

  it("flags the race that most exceeds the fitted curve via bestUpsideOffset, and reports per-race residuals", () => {
    const trueFInf = 0.6;
    const trueTau = 5;
    const durations = [0.5, 1, 2, 4, 8, 16];
    const races = durations.map((h) => makeConstantEffortRace(h, marginTheta(h, trueFInf, trueTau)));
    // One standout race performs 0.15 above what its own duration would predict.
    races.push(makeConstantEffortRace(3, marginTheta(3, trueFInf, trueTau) + 0.15));
    const names = [...durations.map((h) => `${h}h race`), "standout race"];
    const result = fitPacingMarginAcrossRaces(races, names, identityCalibration, baseParams);
    expect(result).not.toBeNull();
    expect(result!.bestUpsideOffset).toBeGreaterThan(0.1);
    const standout = result!.perRace.find((p) => p.name === "standout race");
    expect(standout).toBeDefined();
    expect(standout!.residual).toBeGreaterThan(0.1);
  });

  it("excludes races with no usable chosen theta from the fit but still reports them in perRace", () => {
    const trueFInf = 0.6;
    const trueTau = 5;
    const durations = [0.5, 1, 2, 4, 8];
    const races: EffortTrendPoint[][] = durations.map((h) => makeConstantEffortRace(h, marginTheta(h, trueFInf, trueTau)));
    const noHrRace = makeConstantEffortRace(6, 0.7).map((p) => ({ ...p, heartRateBpm: undefined }));
    races.push(noHrRace);
    const names = [...durations.map((h) => `${h}h race`), "no HR race"];
    const result = fitPacingMarginAcrossRaces(races, names, identityCalibration, baseParams);
    expect(result).not.toBeNull();
    expect(result!.raceCount).toBe(durations.length);
    const missing = result!.perRace.find((p) => p.name === "no HR race");
    expect(missing).toBeDefined();
    expect(missing!.chosenTheta).toBeNull();
    expect(missing!.residual).toBeNull();
  });
});

describe("predictMarginTheta / predictBestDemonstratedTheta", () => {
  const fit: PacingMarginFitResult = {
    marginFInf: 0.6,
    marginTauHours: 5,
    raceCount: 5,
    minDurationHours: 1,
    maxDurationHours: 10,
    bestUpsideOffset: 0.1,
    perRace: [],
  };

  it("evaluates the fitted curve and clamps to [0, 1]", () => {
    expect(predictMarginTheta(0, fit)).toBeCloseTo(1, 6);
    expect(predictMarginTheta(100, fit)).toBeCloseTo(0.6, 2);
    expect(predictMarginTheta(0, fit)).toBeLessThanOrEqual(1);
  });

  it("adds the upside offset and still clamps at 1", () => {
    const base = predictMarginTheta(5, fit);
    expect(predictBestDemonstratedTheta(5, fit)).toBeCloseTo(Math.min(1, base + 0.1), 6);
    expect(predictBestDemonstratedTheta(0, fit)).toBeLessThanOrEqual(1);
  });
});
