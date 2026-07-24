import { describe, expect, it } from "vitest";
import { ceilingPower, sustainableFraction, type CeilingParams } from "./ceiling";
import type { EffortTrendPoint } from "./pacingFit";
import { splitPower } from "./substrate";
import {
  fitHrToEffortCalibrationAcrossRaces,
  fitHrToEffortCalibrationFromThresholds,
  predictEffortFractionFromHr,
  predictHeartRateFromEffortFraction,
  type ThresholdCalibrationInputs,
} from "./hrCalibration";

const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

/** Builds a race whose recorded HR follows a known true (slope, intercept)
 * relationship to effort fraction, plus optional noise -- lets the
 * recovery test check the fit against ground truth, the same discipline
 * every other fit in this codebase uses before trusting real data. */
function makeHrRace(
  totalHours: number,
  trueSlope: number,
  trueIntercept: number,
  opts: { stepMinutes?: number; noise?: (i: number) => number; targetEffortFraction?: number } = {},
): EffortTrendPoint[] {
  const stepMinutes = opts.stepMinutes ?? 6;
  const stepHours = stepMinutes / 60;
  const targetEffortFraction = opts.targetEffortFraction ?? 0.6;
  const points: EffortTrendPoint[] = [];
  let i = 0;
  for (let t = 0.1; t < totalHours; t += stepHours, i++) {
    const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, baseParams);
    const effortFraction = targetEffortFraction + (opts.noise ? opts.noise(i) : 0);
    const grossPowerWPerKg = effortFraction * ceiling;
    // Invert effortFraction = intercept + slope*hr -> hr = (effortFraction - intercept) / slope
    const heartRateBpm = (effortFraction - trueIntercept) / trueSlope;
    points.push({ tHours: t, grossPowerWPerKg, altitudeM: 0, dtS: stepMinutes * 60, heartRateBpm });
  }
  return points;
}

/** Builds a race where HR follows a slow-varying underlying effort signal
 * (as physiology predicts -- HR responds to sustained effort, not brief
 * blips), but recorded power has large, independent, zero-mean, high-
 * frequency (alternating segment-to-segment) noise layered on top of that
 * same slow signal -- representing short terrain-driven fluctuations HR
 * doesn't track. Used to check that smoothing power before regressing
 * against HR recovers the true relationship despite that noise -- a raw
 * point-by-point comparison would be swamped by it. */
function makeHrRaceWithPowerNoise(
  totalHours: number,
  trueSlope: number,
  trueIntercept: number,
  powerNoiseAmplitude: number,
  stepMinutes = 1,
): EffortTrendPoint[] {
  const stepHours = stepMinutes / 60;
  const points: EffortTrendPoint[] = [];
  let i = 0;
  for (let t = 0.1; t < totalHours; t += stepHours, i++) {
    // Slow-varying (few-cycles-per-race) underlying effort -- this is what HR tracks.
    const slowEffortFraction = 0.6 + 0.1 * Math.sin((2 * Math.PI * t) / (totalHours / 3));
    const ceiling = ceilingPower({ tMin: t * 60, altitudeM: 0, elapsedHours: t }, baseParams);
    const noisyEffortFraction = slowEffortFraction + (i % 2 === 0 ? powerNoiseAmplitude : -powerNoiseAmplitude);
    const grossPowerWPerKg = noisyEffortFraction * ceiling;
    const heartRateBpm = (slowEffortFraction - trueIntercept) / trueSlope;
    points.push({ tHours: t, grossPowerWPerKg, altitudeM: 0, dtS: stepMinutes * 60, heartRateBpm });
  }
  return points;
}

describe("fitHrToEffortCalibrationAcrossRaces", () => {
  it("recovers a known slope/intercept from synthetic noiseless data", () => {
    // effortFraction = 0.002*hr - 0.2, e.g. hr=140 -> 0.08... use a
    // realistic-looking mapping: at hr=150 effort=0.55, at hr=170 effort=0.75
    // -> slope=0.01, intercept=-1.0.
    const trueSlope = 0.01;
    const trueIntercept = -1.0;
    // Vary target effort fraction a bit across the race so HR (and thus
    // the regression) has real variance to fit against.
    const race = makeHrRace(4, trueSlope, trueIntercept, {
      noise: (i) => 0.15 * Math.sin(i / 3),
    });
    const result = fitHrToEffortCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 3);
    expect(result!.intercept).toBeCloseTo(trueIntercept, 1);
    expect(result!.rSquared).toBeGreaterThan(0.95);
    expect(result!.raceCount).toBe(1);
  });

  it("pools across multiple races at different effort levels", () => {
    const trueSlope = 0.008;
    const trueIntercept = -0.7;
    const raceA = makeHrRace(3, trueSlope, trueIntercept, { targetEffortFraction: 0.5, noise: (i) => 0.1 * Math.sin(i / 2) });
    const raceB = makeHrRace(5, trueSlope, trueIntercept, { targetEffortFraction: 0.65, noise: (i) => 0.1 * Math.cos(i / 4) });
    const result = fitHrToEffortCalibrationAcrossRaces([raceA, raceB], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 2);
    expect(result!.raceCount).toBe(2);
  });

  it("only uses the early portion of each race (drops points past the drift cutoff)", () => {
    // Build a race where the SECOND half's HR deliberately follows a very
    // different (wrong) relationship -- if the fit still recovers the
    // first half's true slope, the early-window restriction is working.
    const trueSlope = 0.01;
    const trueIntercept = -1.0;
    const race = makeHrRace(6, trueSlope, trueIntercept, { noise: (i) => 0.15 * Math.sin(i / 3) });
    const cutoffIndex = Math.floor(race.length * 0.65);
    for (let i = cutoffIndex; i < race.length; i++) {
      race[i] = { ...race[i], heartRateBpm: (race[i].heartRateBpm ?? 0) + 40 }; // drifted HR, same effort
    }
    const result = fitHrToEffortCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 2);
  });

  it("drops points from the start-of-race trim window (warm-up transient), same discipline as the late-race drift cutoff", () => {
    // Build a race where the FIRST ~15 minutes deliberately follow a very
    // different (wrong) relationship, as a settling-in transient would --
    // if the fit still recovers the rest of the race's true slope, the
    // start-of-race trim is working.
    const trueSlope = 0.01;
    const trueIntercept = -1.0;
    const race = makeHrRace(5, trueSlope, trueIntercept, { noise: (i) => 0.15 * Math.sin(i / 3) });
    const startTrimPoints = Math.ceil(15 / 6); // 15min trim / 6min step
    for (let i = 0; i < startTrimPoints; i++) {
      race[i] = { ...race[i], heartRateBpm: (race[i].heartRateBpm ?? 0) - 40 }; // warm-up-depressed HR, same effort
    }
    const result = fitHrToEffortCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 2);
  });

  it("returns null when fewer than MIN_FIT_POINTS points have HR data", () => {
    const race = makeHrRace(0.3, 0.01, -1.0, { stepMinutes: 6 });
    expect(race.length).toBeLessThan(10);
    expect(fitHrToEffortCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null when no point has HR data at all", () => {
    const race = makeHrRace(4, 0.01, -1.0).map((p) => ({ ...p, heartRateBpm: undefined }));
    expect(fitHrToEffortCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null when HR has no variance to regress against", () => {
    const race = makeHrRace(4, 0.01, -1.0).map((p) => ({ ...p, heartRateBpm: 150 }));
    expect(fitHrToEffortCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null for an empty race list", () => {
    expect(fitHrToEffortCalibrationAcrossRaces([], baseParams)).toBeNull();
  });

  it("recovers the true slope through large high-frequency power noise HR doesn't track -- the smoothing this fit relies on", () => {
    // Real-data check (see this file's header doc) found smoothing power
    // over a trailing ~60-90s window before regressing against HR
    // substantially improves R² -- this is the synthetic proof that
    // smoothing is actually doing that job, not just a real-data artifact.
    // Noise amplitude (±0.5) is huge relative to the ±0.1 true signal --
    // a raw point-by-point regression would be dominated by it.
    const trueSlope = 0.01;
    const trueIntercept = -1.0;
    const race = makeHrRaceWithPowerNoise(4, trueSlope, trueIntercept, 0.5, 0.25);
    const result = fitHrToEffortCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeGreaterThan(0); // recovers the right sign/rough scale despite the noise
    expect(result!.slope).toBeLessThan(trueSlope * 3);
    expect(result!.rSquared).toBeGreaterThan(0.3); // would be near 0 without smoothing at this noise level
  });

  it("does not let numerous short races pull the calibration away from what a couple of long races show (regression test: real held-out data found the unrestricted pool under-predicts heart rate on long races by 4-10+ bpm, fixed by reusing pacingFit.ts's poolIndicesInformativeAtReference)", () => {
    const trueSlope = 0.01;
    const trueIntercept = -1.0;
    const misleadingSlope = 0.03;
    const misleadingIntercept = -3.5;
    // Long races (>= baseParams.tauMin=250min=4.17h) carry the TRUE
    // relationship; many short (1h) races carry a deliberately different
    // one -- mirrors the real bug (hundreds of short training runs sitting
    // at low effort fractions swamping a pooled fit that should reflect
    // the athlete's genuine long-race HR-effort relationship).
    const longRaceA = makeHrRace(5, trueSlope, trueIntercept, { targetEffortFraction: 0.55, noise: (i) => 0.1 * Math.sin(i / 3) });
    const longRaceB = makeHrRace(6, trueSlope, trueIntercept, { targetEffortFraction: 0.6, noise: (i) => 0.1 * Math.cos(i / 4) });
    const manyShortRaces = Array.from({ length: 100 }, (_, i) =>
      makeHrRace(1, misleadingSlope, misleadingIntercept, { targetEffortFraction: 0.4, noise: (j) => 0.05 * Math.sin((i + j) / 2) }),
    );
    const result = fitHrToEffortCalibrationAcrossRaces([longRaceA, longRaceB, ...manyShortRaces], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 2);
    expect(result!.raceCount).toBe(2);
  });
});

describe("fitHrToEffortCalibrationFromThresholds", () => {
  const emptyInputs: ThresholdCalibrationInputs = {
    lt1Fraction: 0.65,
    lt2Fraction: 0.85,
    lt1HeartRateBpm: null,
    lt2HeartRateBpm: null,
    fatOxPoints: [],
    walkMaxMs: 2.0,
  };

  it("fits an exact line through LT1 and LT2 when both have heart rate entered", () => {
    const inputs: ThresholdCalibrationInputs = { ...emptyInputs, lt1HeartRateBpm: 150, lt2HeartRateBpm: 175 };
    const result = fitHrToEffortCalibrationFromThresholds(inputs, baseParams);
    expect(result).not.toBeNull();
    expect(result!.pointCount).toBe(2);
    // At tMin=0, sustainableFraction = min(f0, lt2Fraction) = lt2Fraction
    // here (0.94 > 0.85) -- LT2's own effortFraction is exactly 1 by
    // construction, LT1's is lt1Fraction/lt2Fraction.
    const referenceFraction = sustainableFraction(0, baseParams);
    expect(referenceFraction).toBeCloseTo(0.85, 10);
    const lt1EffortFraction = 0.65 / referenceFraction;
    const lt2EffortFraction = 1; // 0.85 / 0.85
    const expectedSlope = (lt2EffortFraction - lt1EffortFraction) / (175 - 150);
    expect(result!.slope).toBeCloseTo(expectedSlope, 6);
    expect(predictEffortFractionFromHr(175, result!)).toBeCloseTo(lt2EffortFraction, 6);
    expect(predictEffortFractionFromHr(150, result!)).toBeCloseTo(lt1EffortFraction, 6);
    // Exactly 2 points -> the line passes through both exactly.
    expect(result!.rSquared).toBeCloseTo(1, 10);
  });

  it("returns null with only one usable point (can't fit a slope)", () => {
    const inputs: ThresholdCalibrationInputs = { ...emptyInputs, lt1HeartRateBpm: 150 };
    expect(fitHrToEffortCalibrationFromThresholds(inputs, baseParams)).toBeNull();
  });

  it("returns null with no lab heart rate data at all", () => {
    expect(fitHrToEffortCalibrationFromThresholds(emptyInputs, baseParams)).toBeNull();
  });

  it("includes fat-ox points that have heart rate, ignores ones that don't", () => {
    const inputs: ThresholdCalibrationInputs = {
      ...emptyInputs,
      lt1HeartRateBpm: 150,
      lt2HeartRateBpm: 175,
      fatOxPoints: [
        { paceMinPerKm: 5.5, heartRateBpm: 165 },
        { paceMinPerKm: 6.5 }, // no heart rate -- must be skipped, not treated as 0
      ],
    };
    const result = fitHrToEffortCalibrationFromThresholds(inputs, baseParams);
    expect(result).not.toBeNull();
    expect(result!.pointCount).toBe(3);
    // With a genuine 3rd point, R^2 is no longer trivially 1 -- just check
    // it's a real, finite number in range.
    expect(result!.rSquared).toBeGreaterThanOrEqual(0);
    expect(result!.rSquared).toBeLessThanOrEqual(1);
  });

  it("returns null when only a heart-rate-less fat-ox point is available", () => {
    const inputs: ThresholdCalibrationInputs = {
      ...emptyInputs,
      lt1HeartRateBpm: 150,
      fatOxPoints: [{ paceMinPerKm: 6 }],
    };
    expect(fitHrToEffortCalibrationFromThresholds(inputs, baseParams)).toBeNull();
  });
});

describe("predictEffortFractionFromHr", () => {
  it("applies the linear mapping", () => {
    const calibration = { slope: 0.01, intercept: -1.0, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    expect(predictEffortFractionFromHr(150, calibration)).toBeCloseTo(0.5, 6);
  });
});

describe("predictHeartRateFromEffortFraction", () => {
  it("is the exact inverse of predictEffortFractionFromHr", () => {
    const calibration = { slope: 0.01, intercept: -1.0, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    expect(predictHeartRateFromEffortFraction(0.5, calibration)).toBeCloseTo(150, 6);
    for (const hr of [120, 140, 160, 180]) {
      const effort = predictEffortFractionFromHr(hr, calibration);
      expect(predictHeartRateFromEffortFraction(effort, calibration)).toBeCloseTo(hr, 6);
    }
  });
});

describe("HR-derived power feeding the existing substrate pipeline", () => {
  it("splitPower accepts an HR-calibration-derived power exactly like pace-derived power -- no special-casing needed", () => {
    const calibration = { slope: 0.01, intercept: -1.0, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    const ceiling = ceilingPower({ tMin: 30, altitudeM: 0, elapsedHours: 0.5 }, baseParams);
    const effortFraction = predictEffortFractionFromHr(160, calibration);
    const hrDerivedGrossPowerWPerKg = effortFraction * ceiling;
    const bodyMassKg = 70;
    // splitPower's own intensity fraction `x` is exactly this same
    // effortFraction quantity elsewhere in this codebase (e.g. solver.ts
    // divides grossPower by maxAerobicPower to get it) -- reusing it here
    // directly is the point of this test, not an approximation.
    const split = splitPower(hrDerivedGrossPowerWPerKg * bodyMassKg, effortFraction, bodyMassKg);
    expect(split.carbRateWPerKg).toBeGreaterThanOrEqual(0);
    expect(split.fatRateWPerKg).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(split.carbRateWPerKg)).toBe(true);
    expect(Number.isFinite(split.fatRateWPerKg)).toBe(true);
  });
});
