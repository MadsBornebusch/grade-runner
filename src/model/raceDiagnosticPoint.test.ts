import { describe, expect, it } from "vitest";
import { analyzeRun } from "./analysis";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { RESTING_METABOLISM_W_PER_KG } from "./energetics";
import { costOfRunning } from "./minetti";
import type { CourseSegment, PipelineResult } from "../gpx/pipeline";
import { buildRaceDiagnosticPoint, type BuildRaceDiagnosticPointOptions } from "./raceDiagnosticPoint";

/**
 * Flat (gradient 0) segments paced at a constant fraction of the ceiling
 * computed under `trueParams` -- i.e. a race that held perfectly even
 * effort relative to that fade shape, genuinely decaying over time (unlike
 * a literally-constant pace, which is a degenerate case fitTauMinutes can't
 * pin down -- see the module's fitTauAcrossRaces tests for the same
 * pattern). Speed is derived from the target gross power via Minetti's
 * flat-ground cost, so analyzeRun's own real computation recovers it.
 */
function pacedAtCeilingFractionSegments(
  trueParams: CeilingParams,
  effortLevel: number,
  totalHours: number,
  stepMinutes = 5,
): CourseSegment[] {
  const segments: CourseSegment[] = [];
  const dtS = stepMinutes * 60;
  const costFlat = costOfRunning(0);
  let cumulative = 0;
  const totalSteps = Math.round((totalHours * 60) / stepMinutes);
  for (let i = 0; i < totalSteps; i++) {
    const tMin = i * stepMinutes;
    const targetGrossPower = ceilingPower({ tMin, altitudeM: 0, elapsedHours: tMin / 60 }, trueParams) * effortLevel;
    const speed = (targetGrossPower - RESTING_METABOLISM_W_PER_KG) / costFlat;
    const distance3D = speed * dtS;
    cumulative += distance3D;
    segments.push({
      index: i,
      cumulativeDistance3D: cumulative,
      distanceHorizontal: distance3D,
      distance3D,
      elevation: 0,
      gradient: 0,
      time: null,
      dtS,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
    });
  }
  return segments;
}

function courseFrom(segments: CourseSegment[]): PipelineResult {
  return {
    segments,
    totalDistance3D: segments[segments.length - 1].cumulativeDistance3D,
    totalElevationGain: 0,
    totalElevationLoss: 0,
    hasElevation: true,
    hasTimestamps: true,
    hasHeartRate: false,
    hasPower: false,
  };
}

function options(overrides: Partial<CeilingParams> = {}): BuildRaceDiagnosticPointOptions {
  return {
    bodyMassKg: 70,
    ceilingParams: { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 60, ...overrides },
    fueling: { intakeGPerH: 60 },
    glycogenStoreG: 500,
    walkMaxMs: 2.0,
    altitudeAdjustment: true,
  };
}

// A genuinely long-fade race -- true tau far longer than the "wrong"
// defaults the tests below deliberately pass in, so a naive computation
// (ceiling evaluated at the wrong, too-short default tau) has clearly
// decayed much further than reality by the time this race is still going.
const TRUE_PARAMS: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 2200 };
const EFFORT_LEVEL = 0.6;
const TOTAL_HOURS = 20;

describe("buildRaceDiagnosticPoint", () => {
  it("reports a lower, more honest avgIntensity than the naive (un-refit) computation for a long race", () => {
    const segments = pacedAtCeilingFractionSegments(TRUE_PARAMS, EFFORT_LEVEL, TOTAL_HOURS);
    const course = courseFrom(segments);
    const opts = options({ tauMin: 60 }); // far shorter than the true 2200min fade

    const point = buildRaceDiagnosticPoint("long race", course, opts);
    expect(point).not.toBeNull();

    const naive = analyzeRun(segments, opts).avgEffortFraction;
    expect(point!.avgIntensity).toBeLessThan(naive);
    // The self-consistent reading should land reasonably close to the true
    // 60% this race was actually paced at; the naive one, evaluated against
    // a 60min ceiling that's already decayed to near-fInf, reads much higher.
    expect(Math.abs(point!.avgIntensity - EFFORT_LEVEL)).toBeLessThan(0.15);
  });

  it("recovers a similar avgIntensity regardless of what default tau was assumed going in", () => {
    // Same real pacing, two very different starting assumptions -- the
    // self-consistent result shouldn't depend much on the caller's default,
    // since it re-fits its own tau before reading off avgIntensity.
    const segments = pacedAtCeilingFractionSegments(TRUE_PARAMS, EFFORT_LEVEL, TOTAL_HOURS);
    const course = courseFrom(segments);

    const fromShortDefault = buildRaceDiagnosticPoint("a", course, options({ tauMin: 60 }));
    const fromLongDefault = buildRaceDiagnosticPoint("b", course, options({ tauMin: 1000 }));
    expect(fromShortDefault).not.toBeNull();
    expect(fromLongDefault).not.toBeNull();
    expect(Math.abs(fromShortDefault!.avgIntensity - fromLongDefault!.avgIntensity)).toBeLessThan(0.05);
  });

  it("returns null when the course has no timestamps", () => {
    const segments = pacedAtCeilingFractionSegments(TRUE_PARAMS, EFFORT_LEVEL, 2);
    const course = { ...courseFrom(segments), hasTimestamps: false };
    expect(buildRaceDiagnosticPoint("no timestamps", course, options())).toBeNull();
  });

  it("returns null when total distance is zero", () => {
    const segments = pacedAtCeilingFractionSegments(TRUE_PARAMS, EFFORT_LEVEL, 2);
    const course = { ...courseFrom(segments), totalDistance3D: 0 };
    expect(buildRaceDiagnosticPoint("zero distance", course, options())).toBeNull();
  });

  it("returns null when the solo tau fit hits a search boundary", () => {
    // Too few points to survive trimForPacingFit's MIN_FIT_POINTS gate.
    const segments = pacedAtCeilingFractionSegments(TRUE_PARAMS, EFFORT_LEVEL, 20 / 60, 5); // 20 minutes, 4 points
    const course = courseFrom(segments);
    expect(buildRaceDiagnosticPoint("too short", course, options())).toBeNull();
  });
});
