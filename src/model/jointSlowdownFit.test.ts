import { describe, expect, it } from "vitest";
import { costOfRunning } from "./minetti";
import type { SurfaceCategory } from "../gpx/pipeline";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { fitJointSlowdownModel } from "./jointSlowdownFit";

/** Builds one running-gait segment whose avgSpeedMs is derived from a
 * target log-GAP value at the segment's own gradient -- i.e. reverse-
 * engineers the speed a particular injected linear-combination model would
 * produce, so recovering that model's coefficients from the built segments
 * is a real test of fitJointSlowdownModel's wiring, not a tautology. */
function segmentFromTargetLogGap(params: {
  runId: string;
  index: number;
  targetLogGap: number;
  avgGradient?: number;
  surfaceCategory?: SurfaceCategory;
  gaitMode?: "run" | "walk";
  clockElapsedHours?: number;
  clockNetWork?: number;
  clockHardWork?: number | null;
  impactDescentM?: number;
  heartRateBpm?: number | null;
  measuredPowerWPerKg?: number | null;
}): TaggedMonotonicSegment {
  const timeS = 60;
  const avgGradient = params.avgGradient ?? 0;
  const speed = Math.exp(params.targetLogGap) / costOfRunning(avgGradient);
  return {
    runId: params.runId,
    startIndex: params.index,
    endIndex: params.index,
    distance3D: speed * timeS,
    timeS,
    avgSpeedMs: speed,
    avgGradient,
    gradeSign: 0,
    surfaceCategory: params.surfaceCategory ?? "paved",
    gaitMode: params.gaitMode ?? "run",
    avgMeasuredPowerWPerKg: params.measuredPowerWPerKg ?? null,
    measuredPowerCoverage: (params.measuredPowerWPerKg ?? null) !== null ? 1 : 0,
    avgHeartRateBpm: params.heartRateBpm ?? null,
    heartRateCoverage: (params.heartRateBpm ?? null) !== null ? 1 : 0,
    avgMinettiGrossPowerWPerKg: 0,
    cumulativeElapsedHoursAtStart: params.clockElapsedHours ?? params.index * 0.05,
    cumulativeDistanceMAtStart: params.index * 500,
    cumulativeNetWorkJPerKgAtStart: params.clockNetWork ?? params.index * 100,
    cumulativeHardWorkJPerKgAtStart: params.clockHardWork === undefined ? params.index * 10 : params.clockHardWork,
    cumulativeDescentMAtStart: params.impactDescentM ?? params.index * 3,
    cumulativeDescentImpactAtStart: (params.impactDescentM ?? params.index * 3) * 2,
    cumulativeDescentImpactSquaredAtStart: (params.impactDescentM ?? params.index * 3) * 4,
    cumulativeRunningImpactAtStart: params.index * 0.5,
  };
}

/**
 * Builds RUN_COUNT runs of SEGMENTS_PER_RUN segments each, alternating
 * surface category and varying grade in a pattern decorrelated from
 * surface/elapsed-hours/descent (all of which vary with segment index too)
 * so every column -- including the grade control columns -- has genuine
 * within-run variance uncorrelated with the others, unless a test's own
 * targetLogGap callback deliberately builds in a correlation to test for.
 */
function buildLibrary(
  runCount: number,
  segmentsPerRun: number,
  targetLogGap: (opts: {
    surfaceCategory: SurfaceCategory;
    avgGradient: number;
    clockElapsedHours: number;
    impactDescentM: number;
  }) => number,
): TaggedMonotonicSegment[] {
  const library: TaggedMonotonicSegment[] = [];
  for (let r = 0; r < runCount; r++) {
    for (let i = 0; i < segmentsPerRun; i++) {
      const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
      const avgGradient = ((i % 7) - 3) * 0.03;
      const clockElapsedHours = i * 0.05;
      // Deliberately NOT a scalar multiple of clockElapsedHours -- otherwise
      // clock and impact would be exactly collinear in every test using
      // this helper, regardless of what each test intends to isolate.
      const impactDescentM = ((i * 13) % 17) * 1.5;
      library.push(
        segmentFromTargetLogGap({
          runId: `run-${r}`,
          index: i,
          targetLogGap: targetLogGap({ surfaceCategory, avgGradient, clockElapsedHours, impactDescentM }),
          surfaceCategory,
          avgGradient,
          clockElapsedHours,
          impactDescentM,
        }),
      );
    }
  }
  return library;
}

function coefficientFor(result: NonNullable<ReturnType<typeof fitJointSlowdownModel>>, column: string): number {
  const idx = result.columns.indexOf(column);
  expect(idx).toBeGreaterThanOrEqual(0);
  return result.coefficients[idx];
}

describe("fitJointSlowdownModel", () => {
  it("recovers an injected surface offset with grade/clock/impact near zero", () => {
    const base = Math.log(3);
    const gravelOffset = -0.15;
    const library = buildLibrary(8, 20, ({ surfaceCategory }) => base + (surfaceCategory === "gravel" ? gravelOffset : 0));

    const result = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(gravelOffset, 3);
    expect(coefficientFor(result!, "grade")).toBeCloseTo(0, 3);
    expect(coefficientFor(result!, "gradeSquared")).toBeCloseTo(0, 3);
    expect(coefficientFor(result!, "aerobicClock")).toBeCloseTo(0, 3);
    expect(coefficientFor(result!, "impact")).toBeCloseTo(0, 3);
    expect(result!.rSquaredWithinRun).toBeGreaterThan(0.99);
  });

  it("recovers an injected aerobic-fade clock coefficient with grade/surface/impact near zero", () => {
    const base = Math.log(3);
    const clockCoeff = -0.02;
    const library = buildLibrary(8, 20, ({ clockElapsedHours }) => base + clockCoeff * clockElapsedHours);

    const result = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "aerobicClock")).toBeCloseTo(clockCoeff, 3);
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(0, 3);
    expect(coefficientFor(result!, "impact")).toBeCloseTo(0, 3);
  });

  it("recovers an injected impact coefficient with grade/surface/clock near zero", () => {
    const base = Math.log(3);
    const impactCoeff = -0.01;
    const library = buildLibrary(8, 20, ({ impactDescentM }) => base + impactCoeff * impactDescentM);

    const result = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "impact")).toBeCloseTo(impactCoeff, 3);
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(0, 3);
    expect(coefficientFor(result!, "aerobicClock")).toBeCloseTo(0, 3);
  });

  it("attributes a grade-correlated slowdown to the grade control, not to surface, when surface and grade are correlated", () => {
    // Mirrors the real bug this test guards against (PLAN.md §14 stage 5):
    // gravel segments run steeper than paved ones (correlated, not just
    // coincidentally varying), and the TRUE slowdown is a grade^2 effect
    // (standing in for "Minetti's own curve isn't quite exact for this
    // athlete at steep grades") with only a SMALL genuine surface offset.
    // Without a grade control, the grade^2-driven slowdown would leak into
    // the gravel dummy since gravel is disproportionately the steep
    // segments; with it, gravel's own coefficient should stay close to the
    // small true value.
    const base = Math.log(3);
    const trueGravelOffset = -0.01;
    const trueGradeSquaredCoeff = -0.8;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 10; r++) {
      for (let i = 0; i < 30; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        // Gravel runs steeper than paved -- the confound.
        const avgGradient = (surfaceCategory === "gravel" ? 0.18 : 0.02) + ((i % 5) - 2) * 0.005;
        const clockElapsedHours = i * 0.05;
        const impactDescentM = ((i * 13) % 17) * 1.5;
        const targetLogGap =
          base + trueGradeSquaredCoeff * avgGradient * avgGradient + (surfaceCategory === "gravel" ? trueGravelOffset : 0);
        library.push(
          segmentFromTargetLogGap({
            runId: `run-${r}`,
            index: i,
            targetLogGap,
            surfaceCategory,
            avgGradient,
            clockElapsedHours,
            impactDescentM,
          }),
        );
      }
    }

    const result = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "gradeSquared")).toBeCloseTo(trueGradeSquaredCoeff, 2);
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(trueGravelOffset, 2);
  });

  it("reports a high VIF for clock and impact when they're near-collinear within runs", () => {
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        const avgGradient = ((i % 7) - 3) * 0.03;
        const clockElapsedHours = i * 0.05;
        // Near-exact linear function of clock (a small deterministic
        // perturbation, not exact, so the design stays solvable but the two
        // columns are still highly correlated -- enough to flag a high
        // VIF without tripping solveLinearSystem's near-singularity guard).
        const impactDescentM = clockElapsedHours * 40 + (i % 3) * 2;
        library.push(
          segmentFromTargetLogGap({
            runId: `run-${r}`,
            index: i,
            targetLogGap: Math.log(3),
            surfaceCategory,
            avgGradient,
            clockElapsedHours,
            impactDescentM,
          }),
        );
      }
    }
    const result = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(result).not.toBeNull();
    const clockVif = result!.variableInflationFactors[result!.columns.indexOf("aerobicClock")];
    const impactVif = result!.variableInflationFactors[result!.columns.indexOf("impact")];
    expect(clockVif).toBeGreaterThan(10);
    expect(impactVif).toBeGreaterThan(10);
  });

  it("returns null when no run has more than one usable segment", () => {
    const library = [0, 1, 2].map((r) => segmentFromTargetLogGap({ runId: `run-${r}`, index: 0, targetLogGap: Math.log(3) }));
    expect(fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" })).toBeNull();
  });

  it("returns null for an empty library", () => {
    expect(fitJointSlowdownModel([], { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" })).toBeNull();
  });

  it("excludes walk-gait segments and segments with undefined surface from the fit", () => {
    const base = Math.log(3);
    const cleanLibrary = buildLibrary(4, 10, ({ surfaceCategory }) => base + (surfaceCategory === "gravel" ? -0.1 : 0));

    // Add walk-gait and undefined-surface noise segments that would badly
    // distort the fit if they weren't excluded (wildly different target).
    const noise: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 4; r++) {
      noise.push(
        segmentFromTargetLogGap({ runId: `run-${r}`, index: 100, targetLogGap: Math.log(0.5), gaitMode: "walk" }),
        { ...segmentFromTargetLogGap({ runId: `run-${r}`, index: 101, targetLogGap: Math.log(10) }), surfaceCategory: undefined },
      );
    }

    const withoutNoise = fitJointSlowdownModel(cleanLibrary, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    const withNoise = fitJointSlowdownModel([...cleanLibrary, ...noise], {
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(withoutNoise).not.toBeNull();
    expect(withNoise).not.toBeNull();
    expect(withNoise!.segmentCount).toBe(withoutNoise!.segmentCount);
    expect(coefficientFor(withNoise!, "gravel")).toBeCloseTo(coefficientFor(withoutNoise!, "gravel"), 6);
  });

  it("excludes segments with null hard work when aerobicClockBasis is hardWork, without erroring on other bases", () => {
    const library = buildLibrary(4, 10, () => Math.log(3)).map((s, i) => ({
      ...s,
      cumulativeHardWorkJPerKgAtStart: i % 5 === 0 ? null : s.cumulativeHardWorkJPerKgAtStart,
    }));
    const hardWorkResult = fitJointSlowdownModel(library, { aerobicClockBasis: "hardWork", impactBasis: "descentMeters" });
    const elapsedHoursResult = fitJointSlowdownModel(library, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    expect(hardWorkResult).not.toBeNull();
    expect(elapsedHoursResult).not.toBeNull();
    expect(hardWorkResult!.segmentCount).toBeLessThan(elapsedHoursResult!.segmentCount);
  });
});
