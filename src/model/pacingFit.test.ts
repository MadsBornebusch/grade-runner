import { describe, expect, it } from "vitest";
import { analyzeRun } from "./analysis";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { descentImpact, descentImpactSquared, descentMeters } from "./descentImpact";
import type { CourseSegment } from "../gpx/pipeline";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  computeEffortTrend,
  computeFadeTrend,
  type EffortTrendPoint,
  fitDurabilityDriftPerDescentUnit,
  fitDurabilityDriftPerDescentUnitAcrossRaces,
  fitDurabilityDriftPerHour,
  fitFInfAndTauAcrossRaces,
  fitSurfaceDriftAcrossRaces,
  fitSurfaceDriftPerUnpavedUnit,
  fitTauAcrossRaces,
  fitTauFInfWithSupportGate,
  fitTauMinutes,
  suggestFitImprovements,
  trimForPacingFit,
} from "./pacingFit";
import { cumulativeUnpavedMForSegments } from "./surfaceExposure";

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

describe("computeFadeTrend", () => {
  const flatCeilingParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.7, fInf: 0.7, tauMin: 1000 };

  /** Alternating "running" / "walk break" points, holding the walk level and
   * proportion fixed across both halves so only the running level itself
   * declines -- mirrors the real Soria Moria pattern (see this session's
   * investigation): the same amount of walk-break noise diluting the
   * average in both halves, on top of a real decline in what the runner can
   * still do. Ceiling is held flat (f0=fInf) so grossPowerWPerKg fractions
   * translate directly to effort fractions without the fade curve itself
   * contributing any slope. */
  function makeWalkDilutedRace(runLevelFirstHalf: number, runLevelSecondHalf: number, walkLevel: number) {
    const points: EffortTrendPoint[] = [];
    const totalHours = 8;
    const stepMinutes = 5;
    const stepHours = stepMinutes / 60;
    let i = 0;
    for (let t = 0; t < totalHours; t += stepHours, i++) {
      const runLevel = t < totalHours / 2 ? runLevelFirstHalf : runLevelSecondHalf;
      const level = i % 2 === 0 ? runLevel : walkLevel;
      points.push({ tHours: t, grossPowerWPerKg: level, altitudeM: 0, dtS: stepMinutes * 60 });
    }
    return points;
  }

  it("detects a decline in peak effort that computeEffortTrend's flat average substantially understates", () => {
    const points = makeWalkDilutedRace(0.8, 0.6, 0.3);
    const peak = computeFadeTrend(points, flatCeilingParams);
    const flat = computeEffortTrend(points, flatCeilingParams);
    expect(peak).not.toBeNull();
    expect(flat).not.toBeNull();
    // Peak effort itself dropped 0.8 -> 0.6 (a 0.2 swing); the alternating
    // walk breaks (constant at 0.3 throughout) pull the flat average's own
    // apparent swing down to half that (0.55 -> 0.45). Both are negative,
    // but peak should detect a clearly larger decline.
    expect(peak!.slopePerHour).toBeLessThan(0);
    expect(flat!.slopePerHour).toBeLessThan(0);
    expect(Math.abs(peak!.slopePerHour)).toBeGreaterThan(Math.abs(flat!.slopePerHour) * 1.5);
  });

  it("agrees with computeEffortTrend when effort is genuinely constant (no walk breaks to dilute)", () => {
    const points = makeWalkDilutedRace(0.6, 0.6, 0.6);
    const peak = computeFadeTrend(points, flatCeilingParams);
    const flat = computeEffortTrend(points, flatCeilingParams);
    expect(peak!.slopePerHour).toBeCloseTo(0, 2);
    expect(flat!.slopePerHour).toBeCloseTo(0, 2);
  });

  it("falls back to computeEffortTrend on a short race with too few bins to bin meaningfully", () => {
    // 40 minutes of 5-min points -- nowhere near the 4 usable 30-min bins
    // computeFadeTrend needs, so it should degrade to the exact same result
    // as computeEffortTrend rather than returning null or something else.
    const points = makeWalkDilutedRace(0.8, 0.6, 0.3).filter((p) => p.tHours < 40 / 60);
    const peak = computeFadeTrend(points, flatCeilingParams);
    const flat = computeEffortTrend(points, flatCeilingParams);
    expect(peak).toEqual(flat);
  });
});

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

  describe("recency weighting", () => {
    const recentTau = 150;
    const staleTau = 600;
    const now = new Date("2026-01-01");
    const recentDate = new Date("2025-12-25"); // 7 days ago
    const staleDate = new Date("2025-01-01"); // 365 days ago

    it("down-weights an old race so a recent race's own tau dominates the pooled fit", () => {
      const recentRace = makeConstantEffortPoints({ ...baseParams, tauMin: recentTau }, 4);
      const staleRace = makeConstantEffortPoints({ ...baseParams, tauMin: staleTau }, 4);
      const result = fitTauAcrossRaces(
        [recentRace, staleRace],
        { ...baseParams, tauMin: 300 },
        { raceDates: [recentDate, staleDate], halfLifeDays: 75, now },
      );
      expect(result).not.toBeNull();
      expect(Math.abs(result!.tauMin - recentTau)).toBeLessThan(Math.abs(result!.tauMin - staleTau));
    });

    it("behaves identically to unweighted pooling when no options are given (backward compatible)", () => {
      const raceA = makeConstantEffortPoints({ ...baseParams, tauMin: 150 }, 4);
      const raceB = makeConstantEffortPoints({ ...baseParams, tauMin: 150 }, 7);
      const withEmptyOpts = fitTauAcrossRaces([raceA, raceB], { ...baseParams, tauMin: 400 }, {});
      const withoutOpts = fitTauAcrossRaces([raceA, raceB], { ...baseParams, tauMin: 400 });
      expect(withEmptyOpts!.tauMin).toBe(withoutOpts!.tauMin);
    });

    it("does not discount a race with no known date, unlike one with a known stale date", () => {
      const recentRace = makeConstantEffortPoints({ ...baseParams, tauMin: recentTau }, 4);
      const staleRace = makeConstantEffortPoints({ ...baseParams, tauMin: staleTau }, 4);

      const discounted = fitTauAcrossRaces(
        [recentRace, staleRace],
        { ...baseParams, tauMin: 300 },
        { raceDates: [recentDate, staleDate], halfLifeDays: 75, now },
      )!;
      const undiscounted = fitTauAcrossRaces(
        [recentRace, staleRace],
        { ...baseParams, tauMin: 300 },
        { raceDates: [recentDate, null], halfLifeDays: 75, now },
      )!;
      // With the stale race's date unknown (full weight), it pulls the fit toward its
      // own larger tau more than when it's correctly recognized and discounted as old.
      expect(undiscounted.tauMin).toBeGreaterThan(discounted.tauMin);
    });
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
      expect(result!.informativeRaceCount).toBe(2);
    });

    it("does not flag a clean two-race case where both races genuinely inform the fit", () => {
      const race700 = makeConstantEffortPoints({ ...baseParams, tauMin: 700 }, 700 / 60);
      const race600 = makeConstantEffortPoints({ ...baseParams, tauMin: 600 }, 600 / 60);
      const result = fitTauAcrossRaces([race700, race600], { ...baseParams, tauMin: 250 });
      expect(result).not.toBeNull();
      expect(result!.perRace[0].unresponsive).toBe(false);
      expect(result!.perRace[1].unresponsive).toBe(false);
      expect(result!.informativeRaceCount).toBe(2);
    });

    it("informativeRaceCount drops to 1 when only one long race actually constrains a pool of otherwise-short ones -- the general single-race-blowup guard", () => {
      // Same shape as the real bug report this guard was built for: short,
      // structurally-unresponsive races pooled alongside one long one that
      // alone determines where the fit lands. MIN_INFORMATIVE_RACES callers
      // (backtestFinishTime.ts, RunLibraryPanel.tsx) use this count to
      // decide whether "pooled across N races" is actually true. Reuses the
      // same three races as the test above, just drops one of its two
      // independently-responsive long races (race660) to isolate the case
      // where exactly one race is left carrying the whole fit.
      const race50 = makeRealisticRace(50, 0.8, -0.1, 2);
      const race270 = makeRealisticRace(270, 0.75, -0.02);
      const race960 = makeRealisticRace(960, 0.65, 0.008);

      const result = fitTauAcrossRaces([race50, race270, race960], { ...baseParams, tauMin: 250 });
      expect(result).not.toBeNull();
      expect(result!.informativeRaceCount).toBe(1);
    });
  });
});

describe("fitFInfAndTauAcrossRaces", () => {
  // fInf deliberately distinct from the app's own default (0.38) so a
  // "recovery" isn't just landing back on whatever ceiling.ts already
  // assumes.
  const trueParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.55, tauMin: 300 };

  it("recovers fInf and tau reasonably well when races span a wide duration range", () => {
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = fitFInfAndTauAcrossRaces(races, trueParams);
    expect(result).not.toBeNull();
    expect(result!.fInf).toBeCloseTo(0.55, 1);
    expect(result!.tauMin).toBeGreaterThan(250);
    expect(result!.tauMin).toBeLessThan(350);
    // Ratio is computed from *trimmed* durations (trimForPacingFit clips a
    // few minutes off each end, proportionally more for longer races), so
    // it won't exactly match the raw 15h/1h -- just confirm it's clearly wide.
    expect(result!.durationDiversityRatio).toBeGreaterThan(10);
    expect(result!.hitSearchBoundary.fInf).toBeNull();
    expect(result!.hitSearchBoundary.tau).toBeNull();
  });

  it("still returns a result with durations clustered near one length, but with a low diversity ratio", () => {
    const races = [7, 7.5, 8, 8.5].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = fitFInfAndTauAcrossRaces(races, trueParams);
    expect(result).not.toBeNull();
    expect(result!.durationDiversityRatio).toBeLessThan(1.3);
  });

  it("never returns an fInf at or above lt2Fraction, even for a pacing pattern that never leaves the cap", () => {
    // Flat-at-the-cap pacing (f0 === fInf === lt2Fraction, so the ceiling
    // never decays at all) -- an unconstrained search could push fInf up to
    // or past lt2Fraction and fit this just as well, since sustainableFraction's
    // own cap makes any fInf >= lt2Fraction behave identically. Confirms the
    // search range itself, not just typical data, keeps fInf below the cap.
    const cappedParams = { ...trueParams, f0: trueParams.lt2Fraction!, fInf: trueParams.lt2Fraction! };
    const races = [2, 4, 6].map((h) => makeConstantEffortPoints(cappedParams, h));
    const result = fitFInfAndTauAcrossRaces(races, trueParams);
    expect(result).not.toBeNull();
    expect(result!.fInf).toBeLessThan(trueParams.lt2Fraction!);
  });

  it("returns null when no race has enough trimmed points", () => {
    const tooShort = makeConstantEffortPoints(trueParams, 0.1, 1);
    expect(fitFInfAndTauAcrossRaces([tooShort], trueParams)).toBeNull();
  });

  it("reports per-race trend and unresponsive flags the same shape as fitTauAcrossRaces", () => {
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = fitFInfAndTauAcrossRaces(races, trueParams);
    expect(result).not.toBeNull();
    expect(result!.perRace).toHaveLength(5);
    expect(result!.perRace[0].unresponsive).toBe(true); // the 1h race can't leave the cap at tau~300
    expect(result!.informativeRaceCount).toBe(result!.perRace.filter((r) => !r.unresponsive).length);
    expect(result!.informativeRaceCount).toBeGreaterThanOrEqual(1);
  });
});

describe("fitTauFInfWithSupportGate", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38 };

  /** Raw power trending at a fixed rate off some base level -- not a clean
   * match to any single ceiling shape, more like real GPS/power data.
   * Duplicated locally from fitTauAcrossRaces's own copy (different
   * describe block, different local baseParams) rather than restructuring
   * existing test scoping just to share it. */
  function makeRealisticRace(totalMinutes: number, baseLevel: number, trendPerHour: number, stepMinutes = 5) {
    const points = [];
    const refCeiling = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, baseParams);
    for (let t = 0; t < totalMinutes; t += stepMinutes) {
      const hours = t / 60;
      points.push({ tHours: hours, grossPowerWPerKg: refCeiling * (baseLevel + trendPerHour * hours), altitudeM: 0, dtS: stepMinutes * 60 });
    }
    return points;
  }

  it("selects the joint tier when duration diversity and informative-race count both clear their thresholds", () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = fitTauFInfWithSupportGate(races, trueParams);
    expect(result.tier).toBe("joint");
    expect(result.ceilingParams.fInf).toBeCloseTo(result.fInfFit!.fInf, 6);
    expect(result.ceilingParams.tauMin).toBe(result.fInfFit!.tauMin);
  });

  it("falls back to the tau-only tier when duration diversity is too low for the joint fit but tau alone is still well-supported", () => {
    // Same shape as the real Ecotrail 80 case: a genuinely diverse training
    // set overall, but nothing here spans the ~2x range the joint fit
    // needs -- reuse the same clustered-duration case fitFInfAndTauAcrossRaces's
    // own test already confirms has durationDiversityRatio < 1.3.
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [7, 7.5, 8, 8.5].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = fitTauFInfWithSupportGate(races, trueParams);
    expect(result.tier).toBe("tauOnly");
    expect(result.ceilingParams.tauMin).toBe(result.tauFit!.tauMin);
    expect(result.ceilingParams.fInf).toBe(trueParams.fInf); // held at the input default, not re-fit
  });

  it("falls back to the defaults tier -- the real Soria Moria case -- when neither fit has enough informative races", () => {
    // All three races are similar-length and too short for tau/fInf to
    // move their own ceiling shape at all, regardless of which candidate
    // parameters the search lands on -- the real-world equivalent of a
    // training set with no race anywhere near ultra-length.
    const race15 = makeRealisticRace(15, 0.8, -0.1, 1);
    const race20 = makeRealisticRace(20, 0.78, -0.05, 1);
    const race18 = makeRealisticRace(18, 0.76, -0.08, 1);
    const withTauMin: CeilingParams = { ...baseParams, tauMin: 250 };

    const result = fitTauFInfWithSupportGate([race15, race20, race18], withTauMin);
    expect(result.tier).toBe("defaults");
    expect(result.ceilingParams).toEqual(withTauMin); // completely untouched
  });
});

describe("bootstrapTauConfidenceInterval", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38 };

  /** Deterministic seeded PRNG (mulberry32) -- tests can't rely on real
   * Math.random(). */
  function seededRng(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRealisticRace(totalMinutes: number, baseLevel: number, trendPerHour: number, stepMinutes = 1) {
    const points = [];
    const refCeiling = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, baseParams);
    for (let t = 0; t < totalMinutes; t += stepMinutes) {
      const hours = t / 60;
      points.push({ tHours: hours, grossPowerWPerKg: refCeiling * (baseLevel + trendPerHour * hours), altitudeM: 0, dtS: stepMinutes * 60 });
    }
    return points;
  }

  it("returns null when the underlying fit can't clear the support gate (the real Soria Moria case)", async () => {
    const race15 = makeRealisticRace(15, 0.8, -0.1, 1);
    const race20 = makeRealisticRace(20, 0.78, -0.05, 1);
    const race18 = makeRealisticRace(18, 0.76, -0.08, 1);
    const result = await bootstrapTauConfidenceInterval(
      [race15, race20, race18],
      [null, null, null],
      { ...baseParams, tauMin: 250 },
      { rng: seededRng(1) },
    );
    expect(result).toBeNull();
  });

  it("returns a sensible, ordered interval on a well-supported synthetic training set", async () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const result = await bootstrapTauConfidenceInterval(races, races.map(() => null), trueParams, {
      rng: seededRng(42),
      bootstrapSamples: 40,
    });
    expect(result).not.toBeNull();
    expect(["joint", "tauOnly"]).toContain(result!.tier);
    expect(result!.sampleCount + result!.skippedCount).toBe(40);
    expect(result!.tauSamples).toHaveLength(result!.sampleCount);
    // Sorted ascending.
    for (let i = 1; i < result!.tauSamples.length; i++) {
      expect(result!.tauSamples[i]).toBeGreaterThanOrEqual(result!.tauSamples[i - 1]);
    }
    expect(result!.lowTauMin).toBeLessThanOrEqual(result!.medianTauMin);
    expect(result!.medianTauMin).toBeLessThanOrEqual(result!.highTauMin);
    expect(result!.pointEstimateCeilingParams.tauMin).toBe(result!.pointEstimateTauMin);
  });

  it("is deterministic given the same seeded rng", async () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const raceDates = races.map(() => null);
    const a = await bootstrapTauConfidenceInterval(races, raceDates, trueParams, { rng: seededRng(7), bootstrapSamples: 20 });
    const b = await bootstrapTauConfidenceInterval(races, raceDates, trueParams, { rng: seededRng(7), bootstrapSamples: 20 });
    expect(a).toEqual(b);
  });

  it("produces a narrower interval with more informative races than with fewer", async () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    // Noiseless synthetic races all recover the same tau regardless of
    // which get resampled -- real cross-race disagreement (a small,
    // deterministic per-race tau jitter, uncorrelated with duration) is
    // what bootstrap variance actually measures, same trap caught while
    // testing finishTimeRange.ts's own equivalent claim.
    const jitteredTau = (i: number) => trueParams.tauMin! + (((i * 37) % 21) - 10) * 3;
    const manyRaces = [1, 2, 3, 5, 6, 8, 10, 12, 15, 18].map((h, i) =>
      makeConstantEffortPoints({ ...trueParams, tauMin: jitteredTau(i) }, h),
    );
    const fewRaces = [10, 15].map((h, i) => makeConstantEffortPoints({ ...trueParams, tauMin: jitteredTau(i) }, h));

    const many = await bootstrapTauConfidenceInterval(manyRaces, manyRaces.map(() => null), trueParams, {
      rng: seededRng(3),
      bootstrapSamples: 60,
    });
    const few = await bootstrapTauConfidenceInterval(fewRaces, fewRaces.map(() => null), trueParams, {
      rng: seededRng(3),
      bootstrapSamples: 60,
    });

    expect(many).not.toBeNull();
    expect(few).not.toBeNull();
    const manyWidth = many!.highTauMin - many!.lowTauMin;
    const fewWidth = few!.highTauMin - few!.lowTauMin;
    expect(manyWidth).toBeLessThan(fewWidth);
  });
});

describe("suggestFitImprovements", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38 };

  function makeRealisticRace(totalMinutes: number, baseLevel: number, trendPerHour: number, stepMinutes = 1) {
    const points = [];
    const refCeiling = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, baseParams);
    for (let t = 0; t < totalMinutes; t += stepMinutes) {
      const hours = t / 60;
      points.push({ tHours: hours, grossPowerWPerKg: refCeiling * (baseLevel + trendPerHour * hours), altitudeM: 0, dtS: stepMinutes * 60 });
    }
    return points;
  }

  it("returns no suggestions when there's nothing to say yet", () => {
    expect(suggestFitImprovements(null, null)).toEqual([]);
  });

  it("flags too few informative races when even the tau-only fit is under-supported (the real Soria Moria case)", () => {
    const race15 = makeRealisticRace(15, 0.8, -0.1, 1);
    const race20 = makeRealisticRace(20, 0.78, -0.05, 1);
    const race18 = makeRealisticRace(18, 0.76, -0.08, 1);
    const withTauMin: CeilingParams = { ...baseParams, tauMin: 250 };
    const tauFit = fitTauAcrossRaces([race15, race20, race18], withTauMin);
    const fInfFit = fitFInfAndTauAcrossRaces([race15, race20, race18], withTauMin);

    const suggestions = suggestFitImprovements(tauFit, fInfFit);
    expect(suggestions.some((s) => s.severity === "warning" && s.message.includes("multi-hour"))).toBe(true);
  });

  it("flags races that are too similar in length when duration diversity is too low", () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [7, 7.5, 8, 8.5].map((h) => makeConstantEffortPoints(trueParams, h));
    const tauFit = fitTauAcrossRaces(races, trueParams);
    const fInfFit = fitFInfAndTauAcrossRaces(races, trueParams);

    const suggestions = suggestFitImprovements(tauFit, fInfFit);
    expect(suggestions.some((s) => s.message.includes("too similar in length"))).toBe(true);
  });

  it("reports a well-supported fit as looking fine when everything clears", () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const tauFit = fitTauAcrossRaces(races, trueParams);
    const fInfFit = fitFInfAndTauAcrossRaces(races, trueParams);

    const suggestions = suggestFitImprovements(tauFit, fInfFit);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].severity).toBe("info");
  });

  it("flags a wide tau confidence interval when one is supplied", () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const tauFit = fitTauAcrossRaces(races, trueParams);
    const fInfFit = fitFInfAndTauAcrossRaces(races, trueParams);
    const wideTauCI = {
      tier: "joint" as const,
      pointEstimateTauMin: 300,
      pointEstimateCeilingParams: trueParams,
      lowTauMin: 200,
      medianTauMin: 300,
      highTauMin: 400, // (400-200)/300 = 67% width, clearly above the heuristic threshold
      tauSamples: [],
      sampleCount: 10,
      skippedCount: 0,
    };

    const suggestions = suggestFitImprovements(tauFit, fInfFit, wideTauCI);
    expect(suggestions.some((s) => s.message.includes("confidence interval spans"))).toBe(true);
  });

  it("does not flag a narrow tau confidence interval", () => {
    const trueParams: CeilingParams = { ...baseParams, fInf: 0.55, tauMin: 300 };
    const races = [1, 3, 6, 10, 15].map((h) => makeConstantEffortPoints(trueParams, h));
    const tauFit = fitTauAcrossRaces(races, trueParams);
    const fInfFit = fitFInfAndTauAcrossRaces(races, trueParams);
    const narrowTauCI = {
      tier: "joint" as const,
      pointEstimateTauMin: 300,
      pointEstimateCeilingParams: trueParams,
      lowTauMin: 295,
      medianTauMin: 300,
      highTauMin: 305, // (305-295)/300 ~= 3% width
      tauSamples: [],
      sampleCount: 10,
      skippedCount: 0,
    };

    const suggestions = suggestFitImprovements(tauFit, fInfFit, narrowTauCI);
    expect(suggestions.some((s) => s.message.includes("confidence interval spans"))).toBe(false);
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

describe("fitDurabilityDriftPerDescentUnit (PLAN.md §12/§13 stage 5)", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

  it("recovers a known drift rate keyed to cumulative raw descent meters", () => {
    const trueDrift = 0.0004;
    const points: EffortTrendPoint[] = [];
    for (let t = 0.2; t < 5; t += 0.1) {
      const cumulativeDescentM = t * 400; // a steady downhill grind, ~2000m accumulated by the end
      const ceiling = ceilingPower(
        { tMin: t * 60, altitudeM: 0, elapsedHours: t, descentExposure: cumulativeDescentM },
        { ...baseParams, durabilityDriftPerDescentUnit: trueDrift },
      );
      points.push({ tHours: t, grossPowerWPerKg: ceiling, altitudeM: 0, dtS: 360, cumulativeDescentM });
    }
    const result = fitDurabilityDriftPerDescentUnit(points, "descentMeters", baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerDescentUnit).toBeGreaterThan(trueDrift * 0.5);
    expect(result!.durabilityDriftPerDescentUnit).toBeLessThan(trueDrift * 1.5);
    expect(Math.abs(result!.trendAtFitPctPerHour)).toBeLessThan(1);
  });

  it("also recovers a known drift rate under the descentImpact and descentImpactSquared bases", () => {
    const trueDrift = 0.00002;
    const points: EffortTrendPoint[] = [];
    for (let t = 0.2; t < 5; t += 0.1) {
      const cumulativeDescentImpact = t * 4000;
      const ceiling = ceilingPower(
        { tMin: t * 60, altitudeM: 0, elapsedHours: t, descentExposure: cumulativeDescentImpact },
        { ...baseParams, durabilityDriftPerDescentUnit: trueDrift },
      );
      points.push({ tHours: t, grossPowerWPerKg: ceiling, altitudeM: 0, dtS: 360, cumulativeDescentImpact });
    }
    const result = fitDurabilityDriftPerDescentUnit(points, "descentImpact", baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerDescentUnit).toBeGreaterThan(trueDrift * 0.5);
    expect(result!.durabilityDriftPerDescentUnit).toBeLessThan(trueDrift * 1.5);
  });

  it("returns null when the points carry no descent exposure at all", () => {
    // makeConstantEffortPoints doesn't set any cumulativeDescent* field --
    // a rate can't be identified from zero exposure across the whole race.
    const points = makeConstantEffortPoints(baseParams, 5);
    expect(fitDurabilityDriftPerDescentUnit(points, "descentMeters", baseParams)).toBeNull();
    expect(fitDurabilityDriftPerDescentUnit(points, "descentImpact", baseParams)).toBeNull();
    expect(fitDurabilityDriftPerDescentUnit(points, "descentImpactSquared", baseParams)).toBeNull();
  });
});

describe("fitDurabilityDriftPerDescentUnitAcrossRaces", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

  /** One race with a linearly-ramping cumulative descent exposure, targeting
   * ceilingPower's own drift mechanism at trueDrift directly -- so a perfect
   * fit should flatten every pooled race's trend to ~0 at once. */
  function makeDescentDriftRace(totalHours: number, descentPerHour: number, trueDrift: number, stepMinutes = 6): EffortTrendPoint[] {
    const points: EffortTrendPoint[] = [];
    const stepHours = stepMinutes / 60;
    for (let t = 0.2; t < totalHours; t += stepHours) {
      const cumulativeDescentM = t * descentPerHour;
      const ceiling = ceilingPower(
        { tMin: t * 60, altitudeM: 0, elapsedHours: t, descentExposure: cumulativeDescentM },
        { ...baseParams, durabilityDriftPerDescentUnit: trueDrift },
      );
      points.push({ tHours: t, grossPowerWPerKg: ceiling, altitudeM: 0, dtS: stepMinutes * 60, cumulativeDescentM });
    }
    return points;
  }

  it("recovers a shared drift rate pooled across two races with very different exposure scales/durations", () => {
    const trueDrift = 0.0003;
    const raceA = makeDescentDriftRace(5, 300, trueDrift); // ~1500m of exposure by the end
    const raceB = makeDescentDriftRace(8, 150, trueDrift); // ~1200m of exposure, over a longer race
    const result = fitDurabilityDriftPerDescentUnitAcrossRaces([raceA, raceB], "descentMeters", baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerDescentUnit).toBeGreaterThan(trueDrift * 0.5);
    expect(result!.durabilityDriftPerDescentUnit).toBeLessThan(trueDrift * 1.5);
    expect(result!.perRace).toHaveLength(2);
    for (const race of result!.perRace) {
      expect(Math.abs(race.trendAtFitPctPerHour)).toBeLessThan(Math.abs(race.trendAtCurrentPctPerHour));
      expect(race.unresponsive).toBe(false);
    }
  });

  it("flags a race with negligible descent exposure as unresponsive when pooled with one that has real exposure", () => {
    const trueDrift = 0.0003;
    const responsive = makeDescentDriftRace(5, 300, trueDrift);
    const flat: EffortTrendPoint[] = makeConstantEffortPoints(baseParams, 5).map((p) => ({ ...p, cumulativeDescentM: 0 }));
    const result = fitDurabilityDriftPerDescentUnitAcrossRaces([responsive, flat], "descentMeters", baseParams);
    expect(result).not.toBeNull();
    expect(result!.perRace[0].unresponsive).toBe(false);
    expect(result!.perRace[1].unresponsive).toBe(true);
    expect(result!.informativeRaceCount).toBe(1);
  });

  it("ignores a race with too few points and still fits from the rest", () => {
    const goodRace = makeDescentDriftRace(6, 300, 0.0003);
    const tooShort = makeConstantEffortPoints(baseParams, 0.1, 1);
    const result = fitDurabilityDriftPerDescentUnitAcrossRaces([goodRace, tooShort], "descentMeters", baseParams);
    expect(result).not.toBeNull();
    expect(result!.perRace).toHaveLength(1);
  });

  it("returns null when no race has any descent exposure at all", () => {
    const flatOnly: EffortTrendPoint[] = makeConstantEffortPoints(baseParams, 5).map((p) => ({ ...p, cumulativeDescentM: 0 }));
    expect(fitDurabilityDriftPerDescentUnitAcrossRaces([flatOnly], "descentMeters", baseParams)).toBeNull();
  });

  it("returns null when no race has enough trimmed points", () => {
    const tooShort = makeConstantEffortPoints(baseParams, 0.1, 1);
    expect(fitDurabilityDriftPerDescentUnitAcrossRaces([tooShort], "descentMeters", baseParams)).toBeNull();
  });
});

describe("fitSurfaceDriftPerUnpavedUnit", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

  it("recovers a known drift rate keyed to cumulative unpaved meters", () => {
    const trueDrift = 0.0000012;
    const points: EffortTrendPoint[] = [];
    for (let t = 0.2; t < 5; t += 0.1) {
      const cumulativeUnpavedM = t * 12000; // steady unpaved terrain, ~60000m accumulated by the end
      const ceiling = ceilingPower(
        { tMin: t * 60, altitudeM: 0, elapsedHours: t, unpavedExposureM: cumulativeUnpavedM },
        { ...baseParams, durabilityDriftPerUnpavedUnit: trueDrift },
      );
      points.push({ tHours: t, grossPowerWPerKg: ceiling, altitudeM: 0, dtS: 360, cumulativeUnpavedM });
    }
    const result = fitSurfaceDriftPerUnpavedUnit(points, baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerUnpavedUnit).toBeGreaterThan(trueDrift * 0.5);
    expect(result!.durabilityDriftPerUnpavedUnit).toBeLessThan(trueDrift * 1.5);
    expect(Math.abs(result!.trendAtFitPctPerHour)).toBeLessThan(1);
  });

  it("returns null when the points carry no surface data at all", () => {
    const points = makeConstantEffortPoints(baseParams, 5);
    expect(points[0]).not.toHaveProperty("cumulativeUnpavedM");
    expect(fitSurfaceDriftPerUnpavedUnit(points, baseParams)).toBeNull();
  });

  it("returns null when surface data is present but genuinely 0% unpaved throughout", () => {
    const points = makeConstantEffortPoints(baseParams, 5).map((p) => ({ ...p, cumulativeUnpavedM: 0 }));
    expect(fitSurfaceDriftPerUnpavedUnit(points, baseParams)).toBeNull();
  });
});

describe("fitSurfaceDriftAcrossRaces", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };

  function makeSurfaceDriftRace(totalHours: number, unpavedPerHour: number, trueDrift: number, stepMinutes = 6): EffortTrendPoint[] {
    const points: EffortTrendPoint[] = [];
    const stepHours = stepMinutes / 60;
    for (let t = 0.2; t < totalHours; t += stepHours) {
      const cumulativeUnpavedM = t * unpavedPerHour;
      const ceiling = ceilingPower(
        { tMin: t * 60, altitudeM: 0, elapsedHours: t, unpavedExposureM: cumulativeUnpavedM },
        { ...baseParams, durabilityDriftPerUnpavedUnit: trueDrift },
      );
      points.push({ tHours: t, grossPowerWPerKg: ceiling, altitudeM: 0, dtS: stepMinutes * 60, cumulativeUnpavedM });
    }
    return points;
  }

  it("recovers a shared drift rate pooled across two races with very different exposure scales/durations", () => {
    const trueDrift = 0.000001;
    const raceA = makeSurfaceDriftRace(5, 10000, trueDrift);
    const raceB = makeSurfaceDriftRace(8, 5000, trueDrift);
    const result = fitSurfaceDriftAcrossRaces([raceA, raceB], baseParams);
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerUnpavedUnit).toBeGreaterThan(trueDrift * 0.5);
    expect(result!.durabilityDriftPerUnpavedUnit).toBeLessThan(trueDrift * 1.5);
    expect(result!.perRace).toHaveLength(2);
    for (const race of result!.perRace) {
      expect(Math.abs(race.trendAtFitPctPerHour)).toBeLessThan(Math.abs(race.trendAtCurrentPctPerHour));
      expect(race.unresponsive).toBe(false);
    }
  });

  it("flags a race with negligible unpaved exposure as unresponsive when pooled with one that has real exposure", () => {
    const trueDrift = 0.000001;
    const responsive = makeSurfaceDriftRace(5, 10000, trueDrift);
    const flat: EffortTrendPoint[] = makeConstantEffortPoints(baseParams, 5).map((p) => ({ ...p, cumulativeUnpavedM: 0 }));
    const result = fitSurfaceDriftAcrossRaces([responsive, flat], baseParams);
    expect(result).not.toBeNull();
    expect(result!.perRace[0].unresponsive).toBe(false);
    expect(result!.perRace[1].unresponsive).toBe(true);
    expect(result!.informativeRaceCount).toBe(1);
  });

  it("excludes a race with no surface data at all from the pool, and still fits from the rest", () => {
    const goodRace = makeSurfaceDriftRace(6, 10000, 0.000001);
    const noSurfaceData = makeConstantEffortPoints(baseParams, 6); // no cumulativeUnpavedM field at all
    const result = fitSurfaceDriftAcrossRaces([goodRace, noSurfaceData], baseParams);
    expect(result).not.toBeNull();
    expect(result!.perRace).toHaveLength(1);
  });

  it("ignores a race with too few points and still fits from the rest", () => {
    const goodRace = makeSurfaceDriftRace(6, 10000, 0.000001);
    const tooShort = makeConstantEffortPoints(baseParams, 0.1, 1).map((p) => ({ ...p, cumulativeUnpavedM: 100 }));
    const result = fitSurfaceDriftAcrossRaces([goodRace, tooShort], baseParams);
    expect(result).not.toBeNull();
    expect(result!.perRace).toHaveLength(1);
  });

  it("returns null when no race has any surface data at all", () => {
    const noSurfaceData = makeConstantEffortPoints(baseParams, 5);
    expect(fitSurfaceDriftAcrossRaces([noSurfaceData], baseParams)).toBeNull();
  });

  it("returns null when every race with surface data is genuinely 0% unpaved", () => {
    const flatOnly: EffortTrendPoint[] = makeConstantEffortPoints(baseParams, 5).map((p) => ({ ...p, cumulativeUnpavedM: 0 }));
    expect(fitSurfaceDriftAcrossRaces([flatOnly], baseParams)).toBeNull();
  });
});

describe("buildEffortTrendPoints -- cumulative descent fields", () => {
  const params: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };
  const analysisInputs = {
    bodyMassKg: 70,
    ceilingParams: params,
    fueling: { intakeGPerH: 60 },
    glycogenStoreG: 500,
  };

  /** Mixed climb/descent/flat course, elevation deltas and speeds chosen so
   * raw descent, descent-impact, and descent-impact-squared all diverge
   * from each other (not just scaled copies of the same shape). */
  function descentTestSegments(): CourseSegment[] {
    const steps: { eleDelta: number; distance3D: number; dtS: number }[] = [
      { eleDelta: 0, distance3D: 200, dtS: 100 }, // first segment: no prior elevation, gradient 0 -> falls back to 0 descent
      { eleDelta: -20, distance3D: 200, dtS: 100 }, // descend 20m @ 2 m/s
      { eleDelta: -30, distance3D: 450, dtS: 100 }, // descend 30m @ 4.5 m/s
      { eleDelta: 10, distance3D: 100, dtS: 100 }, // climb -- no descent contribution
      { eleDelta: -30, distance3D: 90, dtS: 100 }, // descend 30m @ 0.9 m/s
      { eleDelta: 0, distance3D: 100, dtS: 100 }, // flat -- no descent contribution
    ];
    let elevation = 0;
    let cumulativeDistance3D = 0;
    return steps.map((s, index) => {
      elevation += s.eleDelta;
      cumulativeDistance3D += s.distance3D;
      return {
        index,
        cumulativeDistance3D,
        distanceHorizontal: s.distance3D,
        distance3D: s.distance3D,
        elevation,
        gradient: 0,
        time: null,
        dtS: s.dtS,
        paused: false,
        heartRateBpm: null,
        powerWatts: null,
      };
    });
  }

  it("tracks cumulative descent exposure *before* each segment, matching descentImpact.ts's whole-array sums by the last point", () => {
    const segments = descentTestSegments();
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);

    // Every segment here is unpaused with a positive ceiling, so all 6
    // should survive analyzeRun's effortFraction filter.
    expect(points).toHaveLength(6);

    // The first point has nothing accumulated before it yet.
    expect(points[0].cumulativeDescentM).toBe(0);
    expect(points[0].cumulativeDescentImpact).toBe(0);
    expect(points[0].cumulativeDescentImpactSquared).toBe(0);

    // The last segment (flat) contributes no further descent of its own, so
    // the exposure recorded "before" it equals the whole race's total --
    // the same total descentImpact.ts's own whole-array functions compute.
    const last = points[points.length - 1];
    expect(last.cumulativeDescentM).toBeCloseTo(descentMeters(segments), 6);
    expect(last.cumulativeDescentImpact).toBeCloseTo(descentImpact(segments), 6);
    expect(last.cumulativeDescentImpactSquared).toBeCloseTo(descentImpactSquared(segments), 6);

    // Sanity: the three metrics should actually differ from each other on
    // this course (not accidentally scaled copies), since speed varies
    // across the descending segments.
    expect(descentMeters(segments)).toBeCloseTo(80, 6); // 20 + 30 + 30
    expect(descentImpact(segments)).toBeCloseTo(20 * 2 + 30 * 4.5 + 30 * 0.9, 6);
    expect(descentImpactSquared(segments)).toBeCloseTo(20 * 2 * 2 + 30 * 4.5 * 4.5 + 30 * 0.9 * 0.9, 6);
  });

  it("leaves cumulative descent fields undefined when omitted by hand-built points (backward compatible)", () => {
    // Every existing test/caller in this file builds points without the new
    // fields -- computeEffortTrend and the tau/fInf fits must behave exactly
    // as before for them.
    const points = makeConstantEffortPoints(params, 3);
    expect(points[0]).not.toHaveProperty("cumulativeDescentM");
  });
});

describe("buildEffortTrendPoints -- cumulative unpaved field", () => {
  const params: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 250 };
  const analysisInputs = {
    bodyMassKg: 70,
    ceilingParams: params,
    fueling: { intakeGPerH: 60 },
    glycogenStoreG: 500,
  };

  function surfaceTestSegments(unpaved: (boolean | undefined)[]): CourseSegment[] {
    let cumulativeDistance3D = 0;
    return unpaved.map((surfaceUnpaved, index) => {
      cumulativeDistance3D += 100;
      return {
        index,
        cumulativeDistance3D,
        distanceHorizontal: 100,
        distance3D: 100,
        elevation: 0,
        gradient: 0,
        time: null,
        dtS: 60,
        paused: false,
        heartRateBpm: null,
        powerWatts: null,
        surfaceUnpaved,
      };
    });
  }

  it("tracks cumulative unpaved exposure *before* each segment, matching cumulativeUnpavedMForSegments's whole-array sum by the last point", () => {
    const segments = surfaceTestSegments([true, true, false, true, false]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);

    expect(points).toHaveLength(5);
    expect(points[0].cumulativeUnpavedM).toBe(0); // nothing accumulated before the first segment

    const last = points[points.length - 1];
    // Exposure "before" the last (paved) segment equals the whole race's
    // total, since that segment contributes nothing further of its own.
    expect(last.cumulativeUnpavedM).toBeCloseTo(cumulativeUnpavedMForSegments(segments), 6);
    expect(cumulativeUnpavedMForSegments(segments)).toBeCloseTo(300, 6); // 3 unpaved segments @ 100m
  });

  it("leaves cumulativeUnpavedM undefined for every point when the course has no surface data at all", () => {
    const segments = surfaceTestSegments([undefined, undefined, undefined]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);
    expect(points.every((p) => p.cumulativeUnpavedM === undefined)).toBe(true);
  });
});
