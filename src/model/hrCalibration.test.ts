import { describe, expect, it } from "vitest";
import { ceilingPower, maxAerobicPower, type CeilingParams } from "./ceiling";
import type { EffortTrendPoint } from "./pacingFit";
import { splitPower } from "./substrate";
import {
  fitHrToPowerCalibrationAcrossRaces,
  fitHrToPowerCalibrationFromThresholds,
  predictHeartRateFromPower,
  predictPowerFromHr,
  type ThresholdCalibrationInputs,
} from "./hrCalibration";

const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

/** Builds a race whose recorded HR follows a known true (slope, intercept)
 * relationship to raw gross power, plus optional noise -- lets the fit be
 * checked against ground truth, the same discipline every other fit in
 * this codebase uses before trusting real data. Power itself doesn't need
 * a ceiling at all (unlike the old effortFraction version of this file) --
 * it's just a plausible-looking running power in W/kg. */
function makeHrRace(
  totalHours: number,
  trueSlope: number,
  trueIntercept: number,
  opts: { stepMinutes?: number; noise?: (i: number) => number; targetPowerWPerKg?: number } = {},
): EffortTrendPoint[] {
  const stepMinutes = opts.stepMinutes ?? 6;
  const stepHours = stepMinutes / 60;
  const targetPowerWPerKg = opts.targetPowerWPerKg ?? 8;
  const points: EffortTrendPoint[] = [];
  let i = 0;
  for (let t = 0.1; t < totalHours; t += stepHours, i++) {
    const grossPowerWPerKg = targetPowerWPerKg + (opts.noise ? opts.noise(i) : 0);
    const heartRateBpm = trueIntercept + trueSlope * grossPowerWPerKg;
    points.push({ tHours: t, grossPowerWPerKg, altitudeM: 0, dtS: stepMinutes * 60, heartRateBpm });
  }
  return points;
}

/** Builds a race where HR follows a slow-varying underlying power signal
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
    // Slow-varying (few-cycles-per-race) underlying power -- this is what HR tracks.
    const slowPowerWPerKg = 8 + 1.5 * Math.sin((2 * Math.PI * t) / (totalHours / 3));
    const noisyPowerWPerKg = slowPowerWPerKg + (i % 2 === 0 ? powerNoiseAmplitude : -powerNoiseAmplitude);
    const heartRateBpm = trueIntercept + trueSlope * slowPowerWPerKg;
    points.push({ tHours: t, grossPowerWPerKg: noisyPowerWPerKg, altitudeM: 0, dtS: stepMinutes * 60, heartRateBpm });
  }
  return points;
}

describe("fitHrToPowerCalibrationAcrossRaces", () => {
  it("recovers a known slope/intercept from synthetic noiseless data", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    // Vary target power a bit across the race so HR (and thus the
    // regression) has real variance to fit against.
    const race = makeHrRace(4, trueSlope, trueIntercept, {
      noise: (i) => 0.5 * Math.sin(i / 3),
    });
    const result = fitHrToPowerCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 1);
    expect(result!.intercept).toBeCloseTo(trueIntercept, 0);
    expect(result!.rSquared).toBeGreaterThan(0.95);
    expect(result!.raceCount).toBe(1);
  });

  it("pools across multiple races at different power levels", () => {
    const trueSlope = 4;
    const trueIntercept = 110;
    const raceA = makeHrRace(3, trueSlope, trueIntercept, { targetPowerWPerKg: 7, noise: (i) => 0.4 * Math.sin(i / 2) });
    const raceB = makeHrRace(5, trueSlope, trueIntercept, { targetPowerWPerKg: 9, noise: (i) => 0.4 * Math.cos(i / 4) });
    const result = fitHrToPowerCalibrationAcrossRaces([raceA, raceB], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 0);
    expect(result!.raceCount).toBe(2);
  });

  it("only uses the early portion of each race (drops points past the drift cutoff)", () => {
    // Build a race where the SECOND half's HR deliberately follows a very
    // different (wrong) relationship -- if the fit still recovers the
    // first half's true slope, the early-window restriction is working.
    const trueSlope = 5;
    const trueIntercept = 100;
    const race = makeHrRace(6, trueSlope, trueIntercept, { noise: (i) => 0.5 * Math.sin(i / 3) });
    const cutoffIndex = Math.floor(race.length * 0.65);
    for (let i = cutoffIndex; i < race.length; i++) {
      race[i] = { ...race[i], heartRateBpm: (race[i].heartRateBpm ?? 0) + 40 }; // drifted HR, same power
    }
    const result = fitHrToPowerCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 0);
  });

  it("drops points from the start-of-race trim window (warm-up transient), same discipline as the late-race drift cutoff", () => {
    // Build a race where the FIRST ~15 minutes deliberately follow a very
    // different (wrong) relationship, as a settling-in transient would --
    // if the fit still recovers the rest of the race's true slope, the
    // start-of-race trim is working.
    const trueSlope = 5;
    const trueIntercept = 100;
    const race = makeHrRace(5, trueSlope, trueIntercept, { noise: (i) => 0.5 * Math.sin(i / 3) });
    // Corrupt exactly the points the 15min start-trim itself drops (race
    // starts at t=0.1h, steps by 0.1h -- t=0.1h/0.2h are <0.25h=15min).
    for (const p of race) {
      if (p.tHours < 0.25) p.heartRateBpm = (p.heartRateBpm ?? 0) - 40; // warm-up-depressed HR, same power
    }
    const result = fitHrToPowerCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 0);
  });

  it("returns null when fewer than MIN_FIT_POINTS points have HR data", () => {
    const race = makeHrRace(0.3, 5, 100, { stepMinutes: 6 });
    expect(race.length).toBeLessThan(10);
    expect(fitHrToPowerCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null when no point has HR data at all", () => {
    const race = makeHrRace(4, 5, 100).map((p) => ({ ...p, heartRateBpm: undefined }));
    expect(fitHrToPowerCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null when power has no variance to regress against", () => {
    const race = makeHrRace(4, 5, 100).map((p) => ({ ...p, grossPowerWPerKg: 8 }));
    expect(fitHrToPowerCalibrationAcrossRaces([race], baseParams)).toBeNull();
  });

  it("returns null for an empty race list", () => {
    expect(fitHrToPowerCalibrationAcrossRaces([], baseParams)).toBeNull();
  });

  it("recovers the true slope through large high-frequency power noise HR doesn't track -- the smoothing this fit relies on", () => {
    // Real-data check (see this file's header doc) found smoothing power
    // over a trailing ~60-90s window before regressing against HR
    // substantially improves R² -- this is the synthetic proof that
    // smoothing is actually doing that job, not just a real-data artifact.
    // Noise amplitude (±3) is huge relative to the ±1.5 true signal -- a
    // raw point-by-point regression would be dominated by it.
    const trueSlope = 5;
    const trueIntercept = 100;
    const race = makeHrRaceWithPowerNoise(4, trueSlope, trueIntercept, 3, 0.25);
    const result = fitHrToPowerCalibrationAcrossRaces([race], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeGreaterThan(0); // recovers the right sign/rough scale despite the noise
    expect(result!.slope).toBeLessThan(trueSlope * 3);
    expect(result!.rSquared).toBeGreaterThan(0.3); // would be near 0 without smoothing at this noise level
  });

  it("does not let numerous short races pull the calibration away from what a couple of long races show (regression test: real held-out data found the unrestricted pool under-predicts heart rate on long races by 4-10+ bpm, fixed by reusing pacingFit.ts's poolIndicesInformativeAtReference)", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    const misleadingSlope = 15;
    const misleadingIntercept = 60;
    // Long races (>= baseParams.tauMin=250min=4.17h) carry the TRUE
    // relationship; many short (1h) races carry a deliberately different
    // one -- mirrors the real bug (hundreds of short training runs sitting
    // at low power swamping a pooled fit that should reflect the athlete's
    // genuine long-race HR-power relationship).
    const longRaceA = makeHrRace(5, trueSlope, trueIntercept, { targetPowerWPerKg: 7, noise: (i) => 0.4 * Math.sin(i / 3) });
    const longRaceB = makeHrRace(6, trueSlope, trueIntercept, { targetPowerWPerKg: 8, noise: (i) => 0.4 * Math.cos(i / 4) });
    const manyShortRaces = Array.from({ length: 100 }, (_, i) =>
      makeHrRace(1, misleadingSlope, misleadingIntercept, { targetPowerWPerKg: 5, noise: (j) => 0.2 * Math.sin((i + j) / 2) }),
    );
    const result = fitHrToPowerCalibrationAcrossRaces([longRaceA, longRaceB, ...manyShortRaces], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 0);
    expect(result!.raceCount).toBe(2);
  });

  it("blends in threshold anchors that aren't locked (LT1/fat-ox), pulling the fit toward them without letting a handful of points outvote real race data", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    const longRaceA = makeHrRace(5, trueSlope, trueIntercept, { targetPowerWPerKg: 7, noise: (i) => 0.3 * Math.sin(i / 3) });
    const longRaceB = makeHrRace(6, trueSlope, trueIntercept, { targetPowerWPerKg: 7.5, noise: (i) => 0.3 * Math.cos(i / 4) });

    const raceOnly = fitHrToPowerCalibrationAcrossRaces([longRaceA, longRaceB], baseParams);
    expect(raceOnly).not.toBeNull();

    // An anchor well above the race data's own power range and inconsistent
    // with the pure race-only fit's own prediction there.
    const anchorPowerWPerKg = 15;
    const anchorHr = 165;
    const raceOnlyPrediction = predictHeartRateFromPower(anchorPowerWPerKg, raceOnly!);
    expect(Math.abs(raceOnlyPrediction - anchorHr)).toBeGreaterThan(3); // confirms the gap this test is closing

    const blended = fitHrToPowerCalibrationAcrossRaces([longRaceA, longRaceB], baseParams, {
      thresholdAnchors: [{ hr: anchorHr, powerWPerKg: anchorPowerWPerKg }],
    });
    expect(blended).not.toBeNull();
    const blendedPrediction = predictHeartRateFromPower(anchorPowerWPerKg, blended!);
    // Pulled meaningfully closer to the anchor, but not simply overwritten
    // by it (not locked) -- a handful of anchor points shouldn't outvote
    // real race data entirely.
    expect(Math.abs(blendedPrediction - anchorHr)).toBeLessThan(Math.abs(raceOnlyPrediction - anchorHr));
    expect(Math.abs(blendedPrediction - anchorHr)).toBeGreaterThan(0.01);
  });

  it("forces the fit through the LT2 anchor exactly when lockThroughLt2 is provided", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    const longRaceA = makeHrRace(5, trueSlope, trueIntercept, { targetPowerWPerKg: 7, noise: (i) => 0.3 * Math.sin(i / 3) });
    const longRaceB = makeHrRace(6, trueSlope, trueIntercept, { targetPowerWPerKg: 7.5, noise: (i) => 0.3 * Math.cos(i / 4) });

    const anchor = { hr: 165, powerWPerKg: 15 };
    const locked = fitHrToPowerCalibrationAcrossRaces([longRaceA, longRaceB], baseParams, { lockThroughLt2: anchor });
    expect(locked).not.toBeNull();
    // Exact, not just "closer" -- the whole point of locking.
    expect(predictHeartRateFromPower(anchor.powerWPerKg, locked!)).toBeCloseTo(anchor.hr, 6);
  });

  it("does not let a threshold anchor consistent with the true relationship weaken the long-race-vs-many-short-races protection", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    const misleadingSlope = 15;
    const misleadingIntercept = 60;
    const longRaceA = makeHrRace(5, trueSlope, trueIntercept, { targetPowerWPerKg: 7, noise: (i) => 0.4 * Math.sin(i / 3) });
    const longRaceB = makeHrRace(6, trueSlope, trueIntercept, { targetPowerWPerKg: 8, noise: (i) => 0.4 * Math.cos(i / 4) });
    const manyShortRaces = Array.from({ length: 100 }, (_, i) =>
      makeHrRace(1, misleadingSlope, misleadingIntercept, { targetPowerWPerKg: 5, noise: (j) => 0.2 * Math.sin((i + j) / 2) }),
    );
    // Anchor consistent with the TRUE relationship at a power no race
    // reaches (near-LT2) -- should reinforce, not distort, the long-race-only result.
    const anchorPowerWPerKg = 15;
    const anchorHr = trueIntercept + trueSlope * anchorPowerWPerKg;
    const result = fitHrToPowerCalibrationAcrossRaces([longRaceA, longRaceB, ...manyShortRaces], baseParams, {
      thresholdAnchors: [{ hr: anchorHr, powerWPerKg: anchorPowerWPerKg }],
    });
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 0);
    expect(result!.raceCount).toBe(2);
  });

  it("excludes GPS-artifact segments (near-zero dt, or implausible power) rather than letting one dominate the fit", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    const race = makeHrRace(4, trueSlope, trueIntercept, { noise: (i) => 0.3 * Math.sin(i / 3) });
    const clean = fitHrToPowerCalibrationAcrossRaces([race], baseParams);
    expect(clean).not.toBeNull();

    // Inject a duplicate-timestamp-style artifact: near-zero dt, absurd
    // power, HR unrelated to it -- exactly the "0.05s, 25m apart" shape
    // found in real cached data.
    const contaminated = [
      ...race,
      { tHours: race[5].tHours + 0.0001, grossPowerWPerKg: 500, altitudeM: 0, dtS: 0.05, heartRateBpm: 90 },
    ];
    const result = fitHrToPowerCalibrationAcrossRaces([contaminated], baseParams);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(clean!.slope, 2);
    expect(result!.pointCount).toBe(clean!.pointCount); // the artifact point itself was dropped
  });

  it("down-weights recovery-lag points (power decayed from its own recent peak while HR is still near its own recent peak)", () => {
    const trueSlope = 5;
    const trueIntercept = 100;
    // A normal race with real power variance (so there's genuine slope
    // signal to protect), dtS=30s steps so the 180s lookback window covers
    // several prior points.
    const clean = makeHrRace(3, trueSlope, trueIntercept, { stepMinutes: 0.5, targetPowerWPerKg: 9, noise: (i) => 2 * Math.sin(i / 20) });
    const baseline = fitHrToPowerCalibrationAcrossRaces([clean], baseParams);
    expect(baseline).not.toBeNull();

    // Splice in a short recovery-lag block partway through: power crashes
    // (well below 75% of its own recent peak) while HR is frozen at that
    // recent peak -- the literal signature this mechanism targets, and
    // NOT the true (power, hr) relationship at all.
    const spliceStart = 60;
    const spliceLen = 10;
    const peakHr = clean[spliceStart - 1].heartRateBpm!;
    const contaminated = clean.map((p, i) => (i >= spliceStart && i < spliceStart + spliceLen ? { ...p, grossPowerWPerKg: 2, heartRateBpm: peakHr } : p));

    const result = fitHrToPowerCalibrationAcrossRaces([contaminated], baseParams);
    expect(result).not.toBeNull();
    // Without down-weighting, the recovery-lag block would pull the slope
    // noticeably away from the clean baseline; down-weighted, it should
    // stay close.
    expect(Math.abs(result!.slope - baseline!.slope)).toBeLessThan(Math.abs(baseline!.slope) * 0.3);
  });
});

describe("fitHrToPowerCalibrationFromThresholds", () => {
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
    const result = fitHrToPowerCalibrationFromThresholds(inputs, baseParams);
    expect(result).not.toBeNull();
    expect(result!.pointCount).toBe(2);
    const maxAerobic = maxAerobicPower(0, baseParams);
    const lt1PowerWPerKg = 0.65 * maxAerobic;
    const lt2PowerWPerKg = 0.85 * maxAerobic;
    const expectedSlope = (175 - 150) / (lt2PowerWPerKg - lt1PowerWPerKg);
    expect(result!.slope).toBeCloseTo(expectedSlope, 6);
    expect(predictPowerFromHr(175, result!)).toBeCloseTo(lt2PowerWPerKg, 4);
    expect(predictPowerFromHr(150, result!)).toBeCloseTo(lt1PowerWPerKg, 4);
    // Exactly 2 points -> the line passes through both exactly.
    expect(result!.rSquared).toBeCloseTo(1, 10);
  });

  it("returns null with only one usable point (can't fit a slope)", () => {
    const inputs: ThresholdCalibrationInputs = { ...emptyInputs, lt1HeartRateBpm: 150 };
    expect(fitHrToPowerCalibrationFromThresholds(inputs, baseParams)).toBeNull();
  });

  it("returns null with no lab heart rate data at all", () => {
    expect(fitHrToPowerCalibrationFromThresholds(emptyInputs, baseParams)).toBeNull();
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
    const result = fitHrToPowerCalibrationFromThresholds(inputs, baseParams);
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
    expect(fitHrToPowerCalibrationFromThresholds(inputs, baseParams)).toBeNull();
  });
});

describe("predictPowerFromHr", () => {
  it("applies the linear mapping", () => {
    const calibration = { slope: 5, intercept: 100, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    expect(predictPowerFromHr(150, calibration)).toBeCloseTo(10, 6);
  });
});

describe("predictHeartRateFromPower", () => {
  it("is the exact inverse of predictPowerFromHr", () => {
    const calibration = { slope: 5, intercept: 100, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    expect(predictHeartRateFromPower(10, calibration)).toBeCloseTo(150, 6);
    for (const powerWPerKg of [6, 8, 10, 12]) {
      const hr = predictHeartRateFromPower(powerWPerKg, calibration);
      expect(predictPowerFromHr(hr, calibration)).toBeCloseTo(powerWPerKg, 6);
    }
  });
});

describe("HR-derived power feeding the existing substrate pipeline", () => {
  it("splitPower accepts an HR-calibration-derived power exactly like pace-derived power -- no special-casing needed", () => {
    const calibration = { slope: 5, intercept: 100, rSquared: 0.9, pointCount: 20, raceCount: 1 };
    const ceiling = ceilingPower({ tMin: 30, altitudeM: 0, elapsedHours: 0.5 }, baseParams);
    const hrDerivedGrossPowerWPerKg = predictPowerFromHr(160, calibration);
    const bodyMassKg = 70;
    // splitPower's own intensity fraction `x` is the power/ceiling ratio
    // computed elsewhere in this codebase (e.g. solver.ts divides
    // grossPower by maxAerobicPower to get it) -- HR-derived power plugs
    // into that same division just like pace-derived power does.
    const intensityFraction = hrDerivedGrossPowerWPerKg / ceiling;
    const split = splitPower(hrDerivedGrossPowerWPerKg * bodyMassKg, intensityFraction, bodyMassKg);
    expect(split.carbRateWPerKg).toBeGreaterThanOrEqual(0);
    expect(split.fatRateWPerKg).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(split.carbRateWPerKg)).toBe(true);
    expect(Number.isFinite(split.fatRateWPerKg)).toBe(true);
  });
});
