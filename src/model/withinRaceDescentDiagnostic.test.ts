import { describe, expect, it } from "vitest";
import { ceilingPower, type CeilingParams } from "./ceiling";
import { RESTING_METABOLISM_W_PER_KG } from "./energetics";
import { costOfRunning } from "./minetti";
import type { CourseSegment, PipelineResult } from "../gpx/pipeline";
import type { BuildRaceDiagnosticPointOptions } from "./raceDiagnosticPoint";
import {
  buildWithinRaceDiagnosticPoint,
  computeWithinRaceDescentDiagnostic,
  type WithinRaceDiagnosticPoint,
} from "./withinRaceDescentDiagnostic";

const TRUE_PARAMS: CeilingParams = { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85, f0: 0.94, fInf: 0.38, tauMin: 300 };
const EFFORT_LEVEL = 0.7;
const TOTAL_HOURS = 4;
const STEP_MINUTES = 2;

/**
 * First half of the race descends at `earlyGradient` (steeper = more
 * descent-impact, both from more elevation loss and higher speed at the
 * same power target); second half is flat. Power targets
 * EFFORT_LEVEL*ceiling(t) throughout the early half, so it resembles a
 * clean single-tau curve there -- but the late half's target additionally
 * decays at `extraDecayPerHour` on top of the normal ceiling curve,
 * simulating "the early descent causes an ongoing extra suppression of
 * later output, beyond what a single clean exponential explains" (not
 * just a one-time level shift, which a re-fit tau can partly absorb).
 * `extraDecayPerHour = 0` means no injected effect (null-control).
 */
function buildRace(earlyGradient: number, extraDecayPerHour: number): CourseSegment[] {
  const dtS = STEP_MINUTES * 60;
  const totalSteps = Math.round((TOTAL_HOURS * 60) / STEP_MINUTES);
  const splitStep = Math.round(totalSteps * 0.5); // matches the diagnostic's default earlyFraction
  const splitHours = (splitStep * STEP_MINUTES) / 60;
  const segments: CourseSegment[] = [];
  let cumulativeDistance3D = 0;
  let elevation = 0;

  for (let i = 0; i < totalSteps; i++) {
    const tMin = i * STEP_MINUTES;
    const tHours = tMin / 60;
    const isEarly = i < splitStep;
    const gradient = isEarly ? earlyGradient : 0;
    const cost = costOfRunning(gradient);
    const extraDecay = isEarly ? 1 : Math.exp(-extraDecayPerHour * (tHours - splitHours));
    const targetGrossPower = ceilingPower({ tMin, altitudeM: 0, elapsedHours: tHours }, TRUE_PARAMS) * EFFORT_LEVEL * extraDecay;
    // `speed` here is along-slope (distance3D/dt) -- what Minetti cost and
    // analyzeRun's own recomputed speed are both based on. Deriving
    // distanceHorizontal from distance3D (not the other way around) is
    // what keeps analyzeRun's recomputed grossPower matching the target
    // exactly, regardless of gradient.
    const speed = (targetGrossPower - RESTING_METABOLISM_W_PER_KG) / cost;
    const distance3D = speed * dtS;
    const distanceHorizontal = distance3D / Math.sqrt(1 + gradient * gradient);
    cumulativeDistance3D += distance3D;
    elevation += gradient * distanceHorizontal;
    segments.push({
      index: i,
      cumulativeDistance3D,
      distanceHorizontal,
      distance3D,
      elevation,
      gradient,
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
  const totalElevationLoss = segments.reduce((sum, s, i) => {
    if (i === 0) return sum;
    const delta = s.elevation - segments[i - 1].elevation;
    return delta < 0 ? sum - delta : sum;
  }, 0);
  return {
    segments,
    totalDistance3D: segments[segments.length - 1].cumulativeDistance3D,
    totalElevationGain: 0,
    totalElevationLoss,
    hasElevation: true,
    hasTimestamps: true,
    hasHeartRate: false,
    hasPower: false,
  };
}

// altitudeAdjustment: false -- this synthetic course's `elevation` tracks
// cumulative net descent (can run to unrealistic magnitudes over a
// multi-hour synthetic descent), which analyzeRun would otherwise read as
// real altitude and apply a bogus Cerretelli adjustment to the ceiling
// reference. The descent-metric functions (descentImpact etc.) read
// `elevation` independently of this flag, so disabling it here only
// affects analyzeRun's own ceiling computation, not the descent metrics
// this diagnostic actually needs.
const OPTIONS: BuildRaceDiagnosticPointOptions = {
  bodyMassKg: 70,
  ceilingParams: TRUE_PARAMS,
  fueling: { intakeGPerH: 60, gutMaxGPerH: 60 },
  glycogenStoreG: 500,
  reserveG: 60,
  walkMaxMs: 2.0,
  altitudeAdjustment: false,
};

// Steeper early gradient -> more descent-impact; paired with a
// proportionally larger late-window damage factor, so the two are
// genuinely linked the way a real eccentric-loading effect would be.
const GRADIENTS = [-0.05, -0.1, -0.15, -0.2, -0.25];

describe("buildWithinRaceDiagnosticPoint / computeWithinRaceDescentDiagnostic", () => {
  it("recovers a clear negative correlation when late-window damage genuinely scales with early descent", () => {
    const points: WithinRaceDiagnosticPoint[] = [];
    for (const gradient of GRADIENTS) {
      const extraDecayPerHour = 0.6 * (Math.abs(gradient) / 0.25); // up to 0.6/hour at the steepest
      const course = courseFrom(buildRace(gradient, extraDecayPerHour));
      const point = buildWithinRaceDiagnosticPoint(`gradient ${gradient}`, course, OPTIONS);
      expect(point).not.toBeNull();
      points.push(point!);
    }

    // Sanity check the synthetic construction itself before trusting the
    // correlation: steeper gradient should mean more early descent-impact.
    const impacts = points.map((p) => p.earlyDescentImpactPerKm);
    for (let i = 1; i < impacts.length; i++) expect(impacts[i]).toBeGreaterThan(impacts[i - 1]);

    const result = computeWithinRaceDescentDiagnostic(points);
    expect(result.lateResidualVsEarlyDescentImpactCorrelation).not.toBeNull();
    expect(result.lateResidualVsEarlyDescentImpactCorrelation!).toBeLessThan(-0.8);
  });

  it("reads near zero when early descent varies but has no effect on the late window (null control)", () => {
    const points: WithinRaceDiagnosticPoint[] = [];
    for (const gradient of GRADIENTS) {
      const course = courseFrom(buildRace(gradient, 0)); // no extra decay injected regardless of gradient
      const point = buildWithinRaceDiagnosticPoint(`gradient ${gradient}`, course, OPTIONS);
      expect(point).not.toBeNull();
      points.push(point!);
    }

    // With genuinely zero effect, the late residual doesn't just correlate
    // weakly with early descent -- it's identical across every gradient
    // (gradient never feeds back into the power target here, only into how
    // that target is achieved), so the correlation is undefined (zero
    // variance on one side), not a small nonzero number. Both a null and a
    // small value count as "no spurious signal" -- what would fail this
    // test is a strong correlation appearing out of nothing.
    const result = computeWithinRaceDescentDiagnostic(points);
    const correlation = result.lateResidualVsEarlyDescentImpactCorrelation;
    expect(correlation === null || Math.abs(correlation) < 0.5).toBe(true);
  });

  it("returns null when the course has no timestamps", () => {
    const course = { ...courseFrom(buildRace(-0.1, 0)), hasTimestamps: false };
    expect(buildWithinRaceDiagnosticPoint("no timestamps", course, OPTIONS)).toBeNull();
  });

  it("returns null when total distance is zero", () => {
    const course = { ...courseFrom(buildRace(-0.1, 0)), totalDistance3D: 0 };
    expect(buildWithinRaceDiagnosticPoint("zero distance", course, OPTIONS)).toBeNull();
  });

  it("returns null when the late window doesn't have enough points of its own", () => {
    // A very short race trims down to well under MIN_FIT_POINTS once split in half.
    const shortSegments = buildRace(-0.1, 0).slice(0, 8); // ~16 minutes total
    const course = courseFrom(shortSegments);
    expect(buildWithinRaceDiagnosticPoint("too short", course, OPTIONS)).toBeNull();
  });
});
