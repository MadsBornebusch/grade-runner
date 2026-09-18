import { describe, expect, it } from "vitest";
import { analyzeRun } from "./analysis";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { descentImpact, descentImpactSquared, descentMeters } from "./descentImpact";
import type { CourseSegment, SurfaceCategory } from "../gpx/pipeline";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { findSustainableTheta } from "./solver";
import {
  buildEffortTrendPoints,
  computeEffortTrend,
  computeFadeTrend,
  type EffortTrendPoint,
  fitDurabilityDriftPerHour,
  fitAnaerobicCapacityMin,
  fitDurationCeilingAcrossRaces,
  type DurationCeilingObservation,
  fitSurfaceCostMultipliersFromIntensity,
  fitUnpavedCostMultiplierAcrossRaces,
  trimForPacingFit,
} from "./pacingFit";

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
  // A ceiling that does not fade with duration, so grossPowerWPerKg
  // fractions translate straight into effort fractions and the curve itself
  // contributes no slope. Exponent 0 is what holds it flat now; this used
  // to be expressed as f0 === fInf on the retired exponential curve.
  const flatCeilingParams: CeilingParams = {
    vo2MaxMlPerKgPerMin: 50,
    powerLawFraction60Min: 0.7,
    powerLawExponent: 0,
  };

  /** Alternating "running" / "walk break" points, holding the walk level and
   * proportion fixed across both halves so only the running level itself
   * declines -- mirrors the real Soria Moria pattern (see this session's
   * investigation): the same amount of walk-break noise diluting the
   * average in both halves, on top of a real decline in what the runner can
   * still do. Ceiling is held flat (exponent 0) so grossPowerWPerKg fractions
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

describe("fitDurabilityDriftPerHour", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, };

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
    const points = makeConstantEffortPoints({ ...baseParams, }, 5);
    const result = fitDurabilityDriftPerHour(points, { ...baseParams, });
    expect(result).not.toBeNull();
    expect(result!.durabilityDriftPerHour).toBeCloseTo(0, 2);
  });
});

describe("fitUnpavedCostMultiplierAcrossRaces", () => {
  const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, };
  const commonInputs = { bodyMassKg: 70, fueling: { intakeGPerH: 60 }, glycogenStoreG: 500 };

  function makeMixedSurfaceSegments(n: number, segLenM = 100): CourseSegment[] {
    const segments: CourseSegment[] = [];
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      cumulative += segLenM;
      segments.push({
        index: i,
        cumulativeDistance3D: cumulative,
        distanceHorizontal: segLenM,
        distance3D: segLenM,
        elevation: 0,
        gradient: 0,
        time: null,
        dtS: null,
        paused: false,
        heartRateBpm: null,
        powerWatts: null,
        surfaceUnpaved: i % 2 === 0,
      });
    }
    return segments;
  }

  /** Ground truth for the recoverability tests below: what a training
   * race's actual finish time would be if the real-world unpaved cost
   * multiplier were exactly `trueMultiplier` -- generated with the same
   * solver the fit itself evaluates candidates against, so "recovers X"
   * means "the search converges back to the value used to build the
   * fixture," not just "produces some plausible-looking number." */
  function actualFinishTimeAt(segments: CourseSegment[], trueMultiplier: number): number {
    const { result } = findSustainableTheta({
      segments,
      ceilingParams: baseParams,
      unpavedCostMultiplier: trueMultiplier,
      ...commonInputs,
    });
    return result.finishTimeS;
  }

  it("recovers a known multiplier from a single synthetic mixed-surface race", () => {
    const trueMultiplier = 1.5;
    const segments = makeMixedSurfaceSegments(100); // 10km, half unpaved
    const actualFinishTimeS = actualFinishTimeAt(segments, trueMultiplier);
    const result = fitUnpavedCostMultiplierAcrossRaces([{ segments, actualFinishTimeS }], baseParams, commonInputs);
    expect(result).not.toBeNull();
    expect(result!.unpavedCostMultiplier).toBeGreaterThan(trueMultiplier * 0.85);
    expect(result!.unpavedCostMultiplier).toBeLessThan(trueMultiplier * 1.15);
    expect(result!.perRace[0].fitErrPct).toBeLessThan(result!.perRace[0].baselineErrPct);
    expect(result!.perRace[0].unresponsive).toBe(false);
  });

  it("recovers a shared multiplier pooled across two races of different lengths", () => {
    const trueMultiplier = 1.5;
    const segmentsA = makeMixedSurfaceSegments(100);
    const segmentsB = makeMixedSurfaceSegments(160);
    const races = [
      { segments: segmentsA, actualFinishTimeS: actualFinishTimeAt(segmentsA, trueMultiplier) },
      { segments: segmentsB, actualFinishTimeS: actualFinishTimeAt(segmentsB, trueMultiplier) },
    ];
    const result = fitUnpavedCostMultiplierAcrossRaces(races, baseParams, commonInputs);
    expect(result).not.toBeNull();
    expect(result!.unpavedCostMultiplier).toBeGreaterThan(trueMultiplier * 0.85);
    expect(result!.unpavedCostMultiplier).toBeLessThan(trueMultiplier * 1.15);
    expect(result!.informativeRaceCount).toBe(2);
  });

  it("flags a race with no unpaved segments as unresponsive, and still fits from the rest", () => {
    const trueMultiplier = 1.5;
    const mixed = makeMixedSurfaceSegments(100);
    const allPaved = makeMixedSurfaceSegments(100).map((s) => ({ ...s, surfaceUnpaved: false }));
    const races = [
      { segments: mixed, actualFinishTimeS: actualFinishTimeAt(mixed, trueMultiplier) },
      { segments: allPaved, actualFinishTimeS: actualFinishTimeAt(allPaved, 1) },
    ];
    const result = fitUnpavedCostMultiplierAcrossRaces(races, baseParams, commonInputs);
    expect(result).not.toBeNull();
    expect(result!.perRace[0].unresponsive).toBe(false);
    expect(result!.perRace[1].unresponsive).toBe(true);
    expect(result!.informativeRaceCount).toBe(1);
  });

  it("returns null when no race has any unpaved segments at all", () => {
    const allPaved = makeMixedSurfaceSegments(100).map((s) => ({ ...s, surfaceUnpaved: false }));
    const races = [{ segments: allPaved, actualFinishTimeS: actualFinishTimeAt(allPaved, 1) }];
    expect(fitUnpavedCostMultiplierAcrossRaces(races, baseParams, commonInputs)).toBeNull();
  });

  it("returns null for an empty race list", () => {
    expect(fitUnpavedCostMultiplierAcrossRaces([], baseParams, commonInputs)).toBeNull();
  });
});

describe("fitSurfaceCostMultipliersFromIntensity", () => {
  /** Minimal synthetic TaggedMonotonicSegment builder, same shape as
   * intensityConditionedSlowdownFit.test.ts's own buildSegment -- only the
   * fields that regression actually reads matter here, since this describe
   * block is testing pacingFit.ts's own coefficient->multiplier conversion
   * and null-passthrough, not re-deriving the regression's own correctness
   * (already covered by that file's tests). */
  // Decorrelated from the i%2 surface assignment and from HR -- constant
  // grade left the design singular (no variance to identify the grade
  // column against, same collinearity trap
  // intensityConditionedSlowdownFit.test.ts's own buildLibrary helper
  // avoids the same way).
  function gradeFor(i: number): number {
    return ((i % 7) - 3) * 0.03;
  }

  function buildSegment(params: {
    runId: string;
    index: number;
    targetLogSpeed: number;
    surfaceCategory?: SurfaceCategory;
    heartRateBpm?: number;
  }): TaggedMonotonicSegment {
    const timeS = 60;
    const avgSpeedMs = Math.exp(params.targetLogSpeed);
    return {
      runId: params.runId,
      startIndex: params.index,
      endIndex: params.index,
      distance3D: avgSpeedMs * timeS,
      timeS,
      avgSpeedMs,
      avgGradient: gradeFor(params.index),
      gradeSign: 0,
      surfaceCategory: params.surfaceCategory ?? "paved",
      gaitMode: "run",
      avgMeasuredPowerWPerKg: null,
      measuredPowerCoverage: 0,
      avgHeartRateBpm: params.heartRateBpm ?? 140 + ((params.index * 7) % 13),
      heartRateCoverage: 1,
      avgMinettiGrossPowerWPerKg: 10,
      cumulativeElapsedHoursAtStart: params.index * 0.05,
      cumulativeDistanceMAtStart: params.index * 500,
      cumulativeNetWorkJPerKgAtStart: params.index * 100,
      cumulativeHardWorkJPerKgAtStart: params.index * 10,
      cumulativeDescentMAtStart: ((params.index * 13) % 17) * 1.5,
      cumulativeDescentImpactAtStart: ((params.index * 13) % 17) * 3,
      cumulativeDescentImpactSquaredAtStart: ((params.index * 13) % 17) * 6,
      cumulativeRunningImpactAtStart: params.index * 0.5,
    };
  }

  it("converts an injected pulse-conditioned surface offset to exp(-coefficient), excluding non-surface columns", () => {
    const base = Math.log(3);
    const pathOffset = -0.12; // ~11.3% slower at matched HR
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "path";
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + (surfaceCategory === "path" ? pathOffset : 0),
            surfaceCategory,
          }),
        );
      }
    }
    const result = fitSurfaceCostMultipliersFromIntensity(library);
    expect(result).not.toBeNull();
    expect(result!.surfaceCostMultipliers.path).toBeCloseTo(Math.exp(-pathOffset), 1);
    expect(result!.surfaceCostMultipliers.gravel).toBeUndefined();
    expect(Object.keys(result!.surfaceCostMultipliers)).toEqual(["path"]);
    expect(result!.runCount).toBe(8);
    expect(result!.variableInflationFactors.path).toBeDefined();
  });

  it("returns null when the underlying regression can't be fit (empty library)", () => {
    expect(fitSurfaceCostMultipliersFromIntensity([])).toBeNull();
  });
});

describe("buildEffortTrendPoints -- cumulative descent fields", () => {
  const params: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, };
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

describe("buildEffortTrendPoints -- surfaceUnpaved field", () => {
  const params: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, };
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

  it("carries each segment's own surfaceUnpaved classification through directly (no accumulation)", () => {
    const segments = surfaceTestSegments([true, true, false, true, false]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);

    expect(points).toHaveLength(5);
    expect(points.map((p) => p.surfaceUnpaved)).toEqual([true, true, false, true, false]);
  });

  it("leaves surfaceUnpaved undefined for every point when the course has no surface data at all", () => {
    const segments = surfaceTestSegments([undefined, undefined, undefined]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);
    expect(points.every((p) => p.surfaceUnpaved === undefined)).toBe(true);
  });
});

describe("buildEffortTrendPoints -- heartRateBpm field", () => {
  const params: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, };
  const analysisInputs = {
    bodyMassKg: 70,
    ceilingParams: params,
    fueling: { intakeGPerH: 60 },
    glycogenStoreG: 500,
  };

  function hrTestSegments(hr: (number | null)[]): CourseSegment[] {
    let cumulativeDistance3D = 0;
    return hr.map((heartRateBpm, index) => {
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
        heartRateBpm,
        powerWatts: null,
      };
    });
  }

  it("carries each segment's own recorded heart rate through directly", () => {
    const segments = hrTestSegments([140, 145, 150]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);
    expect(points.map((p) => p.heartRateBpm)).toEqual([140, 145, 150]);
  });

  it("leaves heartRateBpm undefined (not null) when the course has no HR data at all", () => {
    const segments = hrTestSegments([null, null, null]);
    const analysis = analyzeRun(segments, analysisInputs);
    const points = buildEffortTrendPoints(segments, analysis.segments, false);
    expect(points.every((p) => p.heartRateBpm === undefined)).toBe(true);
  });
});

describe("fitDurationCeilingAcrossRaces", () => {
  const FALLBACK = { fraction60Min: 0.81, exponent: 0.16 };
  /** This athlete's 8 real confirmed races, measured time-weighted sustained
   * fraction of VO2max -- the data the power-law mode was built from. */
  const REAL: DurationCeilingObservation[] = [
    { durationMin: 42, sustainedFraction: 0.861, name: "Askerspurten 10k" },
    { durationMin: 92, sustainedFraction: 0.692, name: "Saksumdal 17" },
    { durationMin: 93, sustainedFraction: 0.676, name: "Saksumdal 17 (2)" },
    { durationMin: 432, sustainedFraction: 0.474, name: "OTC 55" },
    { durationMin: 480, sustainedFraction: 0.42, name: "OTC 55 (2)" },
    { durationMin: 505, sustainedFraction: 0.578, name: "Ecotrail 80" },
    { durationMin: 816, sustainedFraction: 0.463, name: "Backyard" },
    { durationMin: 1464, sustainedFraction: 0.408, name: "Soria Moria" },
  ];

  const ceilingAt = (fit: { fraction60Min: number; exponent: number }, tMin: number) =>
    Math.min(fit.fraction60Min * Math.pow(tMin / 60, -fit.exponent), 1);

  it("produces a ceiling no confirmed race exceeds -- the whole point of an envelope", () => {
    const fit = fitDurationCeilingAcrossRaces(REAL, FALLBACK);
    expect(fit.tier).toBe("full");
    for (const r of REAL) {
      expect(ceilingAt(fit, r.durationMin)).toBeGreaterThanOrEqual(r.sustainedFraction - 1e-9);
    }
  });

  it("reproduces the hand-derived envelope, anchored near the athlete's measured LT2", () => {
    // Independent check, not a fitted constraint: LT2 is conventionally
    // ~60-minute power, and this athlete's lab-measured lt2Fraction is 0.814.
    const fit = fitDurationCeilingAcrossRaces(REAL, FALLBACK);
    expect(fit.fraction60Min).toBeCloseTo(0.813, 2);
    expect(fit.exponent).toBeCloseTo(0.16, 2);
  });

  it("rests on the two races that actually bind the hull", () => {
    const fit = fitDurationCeilingAcrossRaces(REAL, FALLBACK);
    expect(fit.bindingRaceNames).toEqual(["Askerspurten 10k", "Ecotrail 80"]);
  });

  it("beats a least-squares trend line, which a real race sits above", () => {
    // The concrete failure that rejected least squares: fit through the
    // middle of these races and Ecotrail lands ~9.7% ABOVE its own ceiling,
    // reproducing the original bug at a different duration.
    const n = REAL.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const r of REAL) {
      const x = Math.log(r.durationMin), y = Math.log(r.sustainedFraction);
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    const lsAtEcotrail = Math.exp(a + b * Math.log(505));
    expect(lsAtEcotrail).toBeLessThan(0.578); // least squares IS exceeded

    const fit = fitDurationCeilingAcrossRaces(REAL, FALLBACK);
    expect(ceilingAt(fit, 505)).toBeGreaterThanOrEqual(0.578); // the envelope is not
  });

  it("holds the exponent when races are clustered too tightly to identify a slope", () => {
    const clustered: DurationCeilingObservation[] = [
      { durationMin: 90, sustainedFraction: 0.68 },
      { durationMin: 100, sustainedFraction: 0.66 },
      { durationMin: 110, sustainedFraction: 0.64 },
    ];
    const fit = fitDurationCeilingAcrossRaces(clustered, FALLBACK);
    expect(fit.tier).toBe("anchorOnly");
    expect(fit.exponent).toBe(FALLBACK.exponent);
    // Still an envelope: every race must sit under it.
    for (const r of clustered) {
      expect(ceilingAt(fit, r.durationMin)).toBeGreaterThanOrEqual(r.sustainedFraction - 1e-9);
    }
  });

  it("applies nothing with too few races", () => {
    const fit = fitDurationCeilingAcrossRaces(REAL.slice(0, 2), FALLBACK);
    expect(fit.tier).toBe("defaults");
    expect(fit.fraction60Min).toBe(FALLBACK.fraction60Min);
    expect(fit.exponent).toBe(FALLBACK.exponent);
  });

  it("rejects a nonsense exponent rather than shipping it", () => {
    // Two near-identical efforts a long way apart in duration imply an
    // almost flat curve -- physiologically not a thing.
    const flat: DurationCeilingObservation[] = [
      { durationMin: 40, sustainedFraction: 0.6 },
      { durationMin: 400, sustainedFraction: 0.599 },
      { durationMin: 1000, sustainedFraction: 0.598 },
    ];
    expect(fitDurationCeilingAcrossRaces(flat, FALLBACK).tier).not.toBe("full");
  });
});

describe("fitAnaerobicCapacityMin", () => {
  const CURVE = { fraction60Min: 0.813, exponent: 0.1602 };

  it("reports not-identifiable when the aerobic envelope already covers every race", () => {
    // The normal outcome, and the correct one: the power law is itself fit
    // as an envelope over these same races, so nothing is left above it for
    // W'/CP to explain. Chained off the real fit exactly as runFitBatch
    // does, rather than off hand-rounded params.
    const races: DurationCeilingObservation[] = [
      { durationMin: 42, sustainedFraction: 0.861 },
      { durationMin: 505, sustainedFraction: 0.578 },
      { durationMin: 1464, sustainedFraction: 0.408 },
    ];
    const curve = fitDurationCeilingAcrossRaces(races, { fraction60Min: 0.81, exponent: 0.16 });
    const fit = fitAnaerobicCapacityMin(races, curve, 1);
    expect(fit.identifiable).toBe(false);
    expect(fit.anaerobicCapacityMin).toBe(1); // fallback held, NOT overwritten with 0
    expect(fit.shortestRaceMin).toBe(42);
  });

  it("fits W'/CP from a short race the VO2max-capped aerobic curve cannot reach", () => {
    // A 10-minute race: the aerobic term is capped at 1.0, so anything above
    // that is necessarily anaerobic and does pin the parameter.
    const fit = fitAnaerobicCapacityMin([{ durationMin: 10, sustainedFraction: 1.15 }], CURVE, 1);
    expect(fit.identifiable).toBe(true);
    // (1 + k/10) * 1.0 >= 1.15  ->  k >= 1.5
    expect(fit.anaerobicCapacityMin).toBeCloseTo(1.5, 6);
  });

  it("takes the binding race when several short races constrain it", () => {
    const fit = fitAnaerobicCapacityMin(
      [
        { durationMin: 10, sustainedFraction: 1.1 },
        { durationMin: 8, sustainedFraction: 1.2 },
      ],
      CURVE,
      1,
    );
    expect(fit.anaerobicCapacityMin).toBeCloseTo(1.6, 6); // 8 * (1.2 - 1)
  });
});
