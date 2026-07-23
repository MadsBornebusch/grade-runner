import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { buildMonotonicSegments } from "./monotonicSegments";
import { DEFAULT_RUNNING_IMPACT_COEFFICIENTS, hillSurchargeKm } from "./runningImpact";

/** Builds a sequential CourseSegment[] from per-segment partial overrides,
 * filling in index/cumulativeDistance3D/elevation consistently -- mirrors
 * the fixed-length pipeline output this module consumes. Defaults to a flat,
 * evenly-paced, unpaused, no-surface-data segment unless overridden. */
function course(specs: Array<Partial<CourseSegment>>): CourseSegment[] {
  let cumulative = 0;
  let elevation = 0;
  return specs.map((spec, i) => {
    const distance3D = spec.distance3D ?? 50;
    const gradient = spec.gradient ?? 0;
    cumulative += distance3D;
    // Elevation is CourseSegment's "at the end of this segment" value (per
    // its own doc), so it must be updated with this segment's own rise
    // BEFORE being assigned below -- not after, which would attribute each
    // segment's rise to the following one instead.
    elevation += gradient * distance3D;
    const seg: CourseSegment = {
      index: i,
      cumulativeDistance3D: cumulative,
      distanceHorizontal: distance3D,
      distance3D,
      elevation,
      gradient,
      time: null,
      dtS: 25,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
      ...spec,
    };
    return seg;
  });
}

/** Single-segment factory for tests that need explicit, un-auto-computed
 * elevation control (e.g. a pause with its own elevation drift) -- mirrors
 * descentImpact.test.ts's own `segment()` helper. */
function seg(overrides: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: 50,
    distance3D: 50,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: 25,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...overrides,
  };
}

describe("buildMonotonicSegments", () => {
  it("splits into one run per grade-sign change", () => {
    const segments = course([
      { gradient: 0.1 },
      { gradient: 0.12 },
      { gradient: 0.11 },
      { gradient: -0.05 },
      { gradient: -0.08 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
    expect(runs[0].gradeSign).toBe(1);
    expect(runs[0].startIndex).toBe(0);
    expect(runs[0].endIndex).toBe(2);
    expect(runs[1].gradeSign).toBe(-1);
    expect(runs[1].startIndex).toBe(3);
    expect(runs[1].endIndex).toBe(4);
  });

  it("does not fragment a flat stretch that noisily straddles zero within the hysteresis band", () => {
    const segments = course([
      { gradient: 0.005 },
      { gradient: -0.008 },
      { gradient: 0.01 },
      { gradient: -0.005 },
      { gradient: 0.003 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0, gradeHysteresisFraction: 0.015 });
    expect(runs).toHaveLength(1);
    expect(runs[0].startIndex).toBe(0);
    expect(runs[0].endIndex).toBe(4);
  });

  it("does fragment across a hysteresis-band crossing once grade genuinely commits to the other side", () => {
    const segments = course([
      { gradient: 0.005 }, // starts near-flat, sign 0 (no prior direction to carry)
      { gradient: -0.03 }, // clears -1.5% hysteresis -> sign -1
      { gradient: -0.04 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0, gradeHysteresisFraction: 0.015 });
    expect(runs).toHaveLength(2);
    expect(runs[0].gradeSign).toBe(0);
    expect(runs[1].gradeSign).toBe(-1);
  });

  it("breaks on a surface change even when grade sign is unchanged", () => {
    const segments = course([
      { gradient: 0.05, surfaceCategory: "paved" },
      { gradient: 0.05, surfaceCategory: "paved" },
      { gradient: 0.05, surfaceCategory: "gravel" },
      { gradient: 0.05, surfaceCategory: "gravel" },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
    expect(runs[0].surfaceCategory).toBe("paved");
    expect(runs[1].surfaceCategory).toBe("gravel");
  });

  it("breaks on a gait change even when grade and surface are unchanged", () => {
    const segments = course([
      { gradient: 0.15, distance3D: 50, dtS: 15 }, // 3.33 m/s -> run
      { gradient: 0.15, distance3D: 50, dtS: 15 },
      { gradient: 0.15, distance3D: 50, dtS: 40 }, // 1.25 m/s -> walk
      { gradient: 0.15, distance3D: 50, dtS: 40 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
    expect(runs[0].gaitMode).toBe("run");
    expect(runs[1].gaitMode).toBe("walk");
  });

  it("breaks across a pause and excludes the paused segment itself, even with matching grade/surface either side", () => {
    const segments = course([
      { gradient: 0.05 },
      { gradient: 0.05 },
      { gradient: 0.05, paused: true, dtS: 120 },
      { gradient: 0.05 },
      { gradient: 0.05 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
    expect(runs[0].endIndex).toBe(1);
    expect(runs[1].startIndex).toBe(3);
    // pause time still advances the elapsed-hours clock for the run that follows it
    expect(runs[1].cumulativeElapsedHoursAtStart).toBeCloseTo((25 * 2 + 120) / 3600, 10);
  });

  it("excludes untimed segments (no dtS) the same way as paused ones", () => {
    const segments = course([{ gradient: 0.05 }, { gradient: 0.05, dtS: null }, { gradient: 0.05 }]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
  });

  it("drops runs that clear neither the distance nor the time floor", () => {
    const segments = course([
      { gradient: 0.05, distance3D: 20, dtS: 8 }, // short run: 20m, 8s -- clears neither a 100m nor 30s floor
      { gradient: -0.05, distance3D: 200, dtS: 80 }, // clears both floors
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 100, minTimeS: 30 });
    expect(runs).toHaveLength(1);
    expect(runs[0].gradeSign).toBe(-1);
  });

  it("keeps a run that clears only the distance floor, or only the time floor", () => {
    const segments = course([
      { gradient: 0.05, distance3D: 150, dtS: 10 }, // clears distance (150>=100), not time
      { gradient: -0.05, distance3D: 20, dtS: 40 }, // clears time (40>=30), not distance
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 100, minTimeS: 30 });
    expect(runs).toHaveLength(2);
  });

  it("accumulates elapsed time, distance, and net work correctly across runs", () => {
    const segments = course([
      { gradient: 0.1, distance3D: 50, dtS: 20 },
      { gradient: 0.1, distance3D: 50, dtS: 20 },
      { gradient: -0.1, distance3D: 50, dtS: 15 },
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(2);
    // first run starts at the very beginning of the course
    expect(runs[0].cumulativeElapsedHoursAtStart).toBe(0);
    expect(runs[0].cumulativeDistanceMAtStart).toBe(0);
    expect(runs[0].cumulativeNetWorkJPerKgAtStart).toBe(0);
    // second run starts after the first run's own 100m/40s
    expect(runs[1].cumulativeDistanceMAtStart).toBe(100);
    expect(runs[1].cumulativeElapsedHoursAtStart).toBeCloseTo(40 / 3600, 10);
    expect(runs[1].cumulativeNetWorkJPerKgAtStart).toBeGreaterThan(0);
  });

  it("computes avgMeasuredPowerWPerKg and coverage only from segments that have device power, and only when bodyMassKg is supplied", () => {
    const segments = course([
      { gradient: 0, distance3D: 50, dtS: 20, powerWatts: 210 },
      { gradient: 0, distance3D: 50, dtS: 20, powerWatts: null },
      { gradient: 0, distance3D: 50, dtS: 20, powerWatts: 230 },
    ]);
    const withoutMass = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(withoutMass[0].avgMeasuredPowerWPerKg).toBeNull();
    expect(withoutMass[0].measuredPowerCoverage).toBe(0);

    const withMass = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0, bodyMassKg: 70 });
    expect(withMass[0].measuredPowerCoverage).toBeCloseTo(2 / 3, 10);
    expect(withMass[0].avgMeasuredPowerWPerKg).toBeCloseTo((210 / 70 + 230 / 70) / 2, 10);
  });

  it("only computes cumulativeHardWorkJPerKgAtStart when ceilingParams is supplied", () => {
    // High-power steep climb followed by a long-enough second run to read the accumulated value from.
    const segments = course([
      { gradient: 0.3, distance3D: 50, dtS: 10 }, // fast steep climb -> high gross power, likely above LT2
      { gradient: -0.3, distance3D: 50, dtS: 30 },
    ]);
    const withoutCeiling = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(withoutCeiling[0].cumulativeHardWorkJPerKgAtStart).toBeNull();
    expect(withoutCeiling[1].cumulativeHardWorkJPerKgAtStart).toBeNull();

    const withCeiling = buildMonotonicSegments(segments, {
      minDistanceM: 0,
      minTimeS: 0,
      ceilingParams: { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85 },
    });
    expect(withCeiling[0].cumulativeHardWorkJPerKgAtStart).toBe(0);
    // the fast steep climb should have driven gross power above the LT2 threshold, accumulating some hard work
    expect(withCeiling[1].cumulativeHardWorkJPerKgAtStart).toBeGreaterThan(0);
  });

  it("returns an empty array for an empty course", () => {
    expect(buildMonotonicSegments([])).toEqual([]);
  });

  it("accumulates the three descent-impact bases across a descending run, readable from the following run's AtStart snapshot", () => {
    const segments = course([
      { gradient: 0, distance3D: 50, dtS: 20 }, // flat baseline, contributes 0 descent
      { gradient: -0.2, distance3D: 50, dtS: 20 }, // 10m drop at 2.5 m/s
      { gradient: -0.2, distance3D: 50, dtS: 20 },
      { gradient: -0.2, distance3D: 50, dtS: 20 },
      { gradient: 0.1, distance3D: 50, dtS: 20 }, // breaks the descending run
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    expect(runs).toHaveLength(3); // [flat], [3 descending], [climb]

    const descendingRun = runs[1];
    expect(descendingRun.gradeSign).toBe(-1);
    // nothing descended before this run (only the flat segment preceded it)
    expect(descendingRun.cumulativeDescentMAtStart).toBe(0);
    expect(descendingRun.cumulativeDescentImpactAtStart).toBe(0);
    expect(descendingRun.cumulativeDescentImpactSquaredAtStart).toBe(0);

    const afterDescent = runs[2];
    // 3 segments x 10m drop at 2.5 m/s each: 30m total, 30*2.5=75 impact, 30*2.5^2=187.5 impact^2
    expect(afterDescent.cumulativeDescentMAtStart).toBeCloseTo(30, 10);
    expect(afterDescent.cumulativeDescentImpactAtStart).toBeCloseTo(75, 10);
    expect(afterDescent.cumulativeDescentImpactSquaredAtStart).toBeCloseTo(187.5, 10);
  });

  it("threads elevation continuity across a pause so descent isn't lost or double-counted", () => {
    const segments: CourseSegment[] = [
      seg({ index: 0, cumulativeDistance3D: 50, elevation: 0, gradient: 0, dtS: 20 }),
      // paused, but elevation still genuinely drifted -5m during the rest
      seg({ index: 1, cumulativeDistance3D: 100, elevation: -5, paused: true, dtS: 90 }),
      // resumes and descends a further 10m from where the pause left off (-5 -> -15)
      seg({ index: 2, cumulativeDistance3D: 150, elevation: -15, gradient: -0.2, dtS: 20 }),
      // breaks the descending run so its AtStart snapshot can be read
      seg({ index: 3, cumulativeDistance3D: 200, elevation: -10, gradient: 0.1, dtS: 20 }),
    ];
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    const afterDescent = runs[runs.length - 1];
    // only the real 10m post-pause drop should count -- not 15m (which would
    // double-count the pause's own -5m drift as if it were a second descent).
    expect(afterDescent.cumulativeDescentMAtStart).toBeCloseTo(10, 10);
  });

  it("computes cumulativeRunningImpactAtStart consistently with runningImpact.ts's own hillSurchargeKm, evaluated on the equivalent course prefix", () => {
    const segments = course([
      { gradient: 0 },
      { gradient: 0.15 },
      { gradient: 0.15 },
      { gradient: -0.05 }, // breaks the climb so its AtStart snapshot can be read
    ]);
    const runs = buildMonotonicSegments(segments, { minDistanceM: 0, minTimeS: 0 });
    const afterClimb = runs[runs.length - 1];

    const priorSegments = segments.slice(0, 3); // flat + the 2-segment climb preceding the final run
    const expectedDistanceKm = priorSegments.reduce((sum, s) => sum + s.distance3D, 0) / 1000;
    const expected =
      DEFAULT_RUNNING_IMPACT_COEFFICIENTS.distanceCoefficient * expectedDistanceKm +
      DEFAULT_RUNNING_IMPACT_COEFFICIENTS.hillSurchargeCoefficient * hillSurchargeKm(priorSegments);
    expect(afterClimb.cumulativeRunningImpactAtStart).toBeCloseTo(expected, 8);
  });

  it("respects a custom runningImpactCoefficients override", () => {
    const segments = course([{ gradient: 0.1 }, { gradient: -0.1 }]);
    const runs = buildMonotonicSegments(segments, {
      minDistanceM: 0,
      minTimeS: 0,
      runningImpactCoefficients: { distanceCoefficient: 0, hillSurchargeCoefficient: 0 },
    });
    expect(runs[1].cumulativeRunningImpactAtStart).toBe(0);
  });
});
