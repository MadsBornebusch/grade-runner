import { describe, expect, it } from "vitest";
import { costOfRunning } from "./minetti";
import { netToGross } from "./energetics";
import type { SurfaceCategory } from "../gpx/pipeline";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { fitIntensityConditionedSlowdownModel } from "./intensityConditionedSlowdownFit";

/** Builds one running-gait segment from an explicit target log-speed and
 * grade, computing avgMinettiGrossPowerWPerKg via the SAME formula
 * workAccumulation.ts uses on real data (netToGross(cost(grade)*speed)) --
 * deliberate, not arbitrary, so the "modelledPower is circular" tests below
 * exercise the real invariant rather than a rigged one. */
function buildSegment(params: {
  runId: string;
  index: number;
  targetLogSpeed: number;
  avgGradient?: number;
  surfaceCategory?: SurfaceCategory;
  gaitMode?: "run" | "walk";
  clockElapsedHours?: number;
  impactDescentM?: number;
  heartRateBpm?: number | null;
  measuredPowerWPerKg?: number | null;
}): TaggedMonotonicSegment {
  const timeS = 60;
  const avgGradient = params.avgGradient ?? 0;
  const avgSpeedMs = Math.exp(params.targetLogSpeed);
  return {
    runId: params.runId,
    startIndex: params.index,
    endIndex: params.index,
    distance3D: avgSpeedMs * timeS,
    timeS,
    avgSpeedMs,
    avgGradient,
    gradeSign: 0,
    surfaceCategory: params.surfaceCategory ?? "paved",
    gaitMode: params.gaitMode ?? "run",
    avgMeasuredPowerWPerKg: params.measuredPowerWPerKg ?? null,
    measuredPowerCoverage: (params.measuredPowerWPerKg ?? null) !== null ? 1 : 0,
    avgHeartRateBpm: params.heartRateBpm ?? null,
    heartRateCoverage: (params.heartRateBpm ?? null) !== null ? 1 : 0,
    avgMinettiGrossPowerWPerKg: netToGross(costOfRunning(avgGradient) * avgSpeedMs),
    cumulativeElapsedHoursAtStart: params.clockElapsedHours ?? params.index * 0.05,
    cumulativeDistanceMAtStart: params.index * 500,
    cumulativeNetWorkJPerKgAtStart: params.index * 100,
    cumulativeHardWorkJPerKgAtStart: params.index * 10,
    // Deliberately NOT a scalar multiple of clockElapsedHours (index*0.05) --
    // otherwise clock and impact would be exactly collinear in every test
    // using this default, same decorrelation jointSlowdownFit.test.ts uses.
    cumulativeDescentMAtStart: params.impactDescentM ?? ((params.index * 13) % 17) * 1.5,
    cumulativeDescentImpactAtStart: (params.impactDescentM ?? ((params.index * 13) % 17) * 1.5) * 2,
    cumulativeDescentImpactSquaredAtStart: (params.impactDescentM ?? ((params.index * 13) % 17) * 1.5) * 4,
    cumulativeRunningImpactAtStart: params.index * 0.5,
  };
}

function coefficientFor(result: NonNullable<ReturnType<typeof fitIntensityConditionedSlowdownModel>>, column: string): number {
  const idx = result.columns.indexOf(column);
  expect(idx).toBeGreaterThanOrEqual(0);
  return result.coefficients[idx];
}

/** Grade and HR patterns deliberately decorrelated from the i%2 surface
 * assignment and from each other -- same discipline as
 * jointSlowdownFit.test.ts's own buildLibrary helper. */
function gradeFor(i: number): number {
  return ((i % 7) - 3) * 0.03;
}
function heartRateFor(i: number): number {
  // Scrambled (not linear in i, unlike a plain i%N*step) so it isn't
  // accidentally collinear with aerobicClock's own default (index*0.05,
  // exactly linear in i) after within-run demeaning -- a real bug this
  // helper hit during development.
  return 140 + ((i * 7) % 13);
}

describe("fitIntensityConditionedSlowdownModel", () => {
  it("recovers an injected surface offset via pulse intensity, with intensity/grade/clock/impact near zero", () => {
    const base = Math.log(3);
    const gravelOffset = -0.15;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + (surfaceCategory === "gravel" ? gravelOffset : 0),
            avgGradient: gradeFor(i),
            surfaceCategory,
            heartRateBpm: heartRateFor(i),
          }),
        );
      }
    }
    const result = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(gravelOffset, 2);
    expect(coefficientFor(result!, "intensity")).toBeCloseTo(0, 2);
    expect(coefficientFor(result!, "aerobicClock")).toBeCloseTo(0, 2);
    expect(coefficientFor(result!, "impact")).toBeCloseTo(0, 2);
  });

  it("recovers an injected pulse coefficient with surface/grade/clock/impact near zero", () => {
    const base = Math.log(3);
    const pulseCoeff = -0.003;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        const heartRateBpm = heartRateFor(i);
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + pulseCoeff * heartRateBpm,
            avgGradient: gradeFor(i),
            surfaceCategory,
            heartRateBpm,
          }),
        );
      }
    }
    const result = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(result).not.toBeNull();
    expect(coefficientFor(result!, "intensity")).toBeCloseTo(pulseCoeff, 3);
    expect(coefficientFor(result!, "gravel")).toBeCloseTo(0, 2);
  });

  it("returns null when a run's heart rate is constant (no within-run pulse variance to fit against)", () => {
    // A degenerate case worth documenting: unlike grade/surface/clock/impact,
    // which always vary somewhat within a run, HR CAN come back exactly flat
    // in a small synthetic run -- the design is then singular for the same
    // reason a genuinely collinear real column would be (see linearSolve.ts).
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < 10; i++) {
        library.push(buildSegment({ runId: `run-${r}`, index: i, targetLogSpeed: Math.log(3), heartRateBpm: 150 }));
      }
    }
    const result = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(result).toBeNull();
  });

  it("shows the modelledPower circularity signature: near-perfect fit and a near-unidentifiable intensity term, for the SAME true surface effect pulse recovers cleanly", () => {
    const base = Math.log(3);
    const gravelOffset = -0.15;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + (surfaceCategory === "gravel" ? gravelOffset : 0),
            avgGradient: gradeFor(i),
            surfaceCategory,
            heartRateBpm: heartRateFor(i),
          }),
        );
      }
    }

    const modelledPowerResult = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "modelledPower",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    const pulseResult = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });

    expect(modelledPowerResult).not.toBeNull();
    expect(pulseResult).not.toBeNull();

    // Circularity fingerprint: modelledPower is deterministic from this same
    // segment's grade+speed, so the fit reconstructs log(speed) almost
    // exactly (R^2 -> 1) regardless of what's driving the true variation.
    // Which of {intensity, gravel} the solver credits is NOT stable or
    // meaningful here -- both are reporting as near-unidentifiable via VIF
    // (this exact library empirically puts full credit on the dummy and
    // ~0 on intensity, but that split is a numerical tie-break artifact of
    // a noiseless synthetic setup, not something to rely on). The honest,
    // robust claim is the VIF blowup itself, not which column "wins".
    expect(modelledPowerResult!.rSquaredWithinRun).toBeGreaterThan(0.999);
    const intensityVif = modelledPowerResult!.variableInflationFactors[modelledPowerResult!.columns.indexOf("intensity")];
    expect(intensityVif).toBeGreaterThan(50);

    // Pulse is an independent signal (uncorrelated with surface here) and
    // recovers the true injected effect cleanly, matching Stage 3's original
    // "HR sees surface, device power doesn't" finding, now inside a joint fit.
    expect(coefficientFor(pulseResult!, "gravel")).toBeCloseTo(gravelOffset, 2);
  });

  it("excludes segments with null intensity for the chosen basis, and walk-gait/undefined-surface segments", () => {
    const base = Math.log(3);
    const cleanLibrary: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        cleanLibrary.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + (surfaceCategory === "gravel" ? -0.1 : 0),
            avgGradient: gradeFor(i),
            surfaceCategory,
            heartRateBpm: heartRateFor(i),
          }),
        );
      }
    }
    const noise: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      noise.push(
        buildSegment({ runId: `run-${r}`, index: 100, targetLogSpeed: Math.log(0.5), gaitMode: "walk", heartRateBpm: 150 }),
        { ...buildSegment({ runId: `run-${r}`, index: 101, targetLogSpeed: Math.log(10), heartRateBpm: 150 }), surfaceCategory: undefined },
        buildSegment({ runId: `run-${r}`, index: 102, targetLogSpeed: Math.log(20), heartRateBpm: null }),
      );
    }

    const withoutNoise = fitIntensityConditionedSlowdownModel(cleanLibrary, {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    const withNoise = fitIntensityConditionedSlowdownModel([...cleanLibrary, ...noise], {
      intensityBasis: "pulse",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(withoutNoise).not.toBeNull();
    expect(withNoise).not.toBeNull();
    expect(withNoise!.segmentCount).toBe(withoutNoise!.segmentCount);
    expect(coefficientFor(withNoise!, "gravel")).toBeCloseTo(coefficientFor(withoutNoise!, "gravel"), 6);
  });

  it("returns null for an empty library", () => {
    expect(
      fitIntensityConditionedSlowdownModel([], { intensityBasis: "pulse", aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" }),
    ).toBeNull();
  });

  it("returns null when no run has more than one usable segment", () => {
    const library = [0, 1, 2].map((r) =>
      buildSegment({ runId: `run-${r}`, index: 0, targetLogSpeed: Math.log(3), heartRateBpm: 150 }),
    );
    expect(
      fitIntensityConditionedSlowdownModel(library, {
        intensityBasis: "pulse",
        aerobicClockBasis: "elapsedHours",
        impactBasis: "descentMeters",
      }),
    ).toBeNull();
  });

  it("measuredPower basis excludes segments with null device power", () => {
    const base = Math.log(3);
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 20; i++) {
        const surfaceCategory: SurfaceCategory = i % 2 === 0 ? "paved" : "gravel";
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            targetLogSpeed: base + (surfaceCategory === "gravel" ? -0.1 : 0),
            avgGradient: gradeFor(i),
            surfaceCategory,
            // device power present on most, but not all, segments -- not tied
            // to the surface parity above, so both categories still survive
            measuredPowerWPerKg: i % 3 !== 0 ? 3 + (i % 5) * 0.1 : null,
          }),
        );
      }
    }
    const result = fitIntensityConditionedSlowdownModel(library, {
      intensityBasis: "measuredPower",
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    expect(result).not.toBeNull();
    expect(result!.segmentCount).toBeLessThan(library.length);
  });
});
