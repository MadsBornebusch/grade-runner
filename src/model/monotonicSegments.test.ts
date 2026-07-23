import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { buildMonotonicSegments } from "./monotonicSegments";

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
    elevation += gradient * distance3D;
    return seg;
  });
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
});
