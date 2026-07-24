import { describe, expect, it } from "vitest";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { fitSegmentPulseToPower } from "./segmentPulsePowerFit";

function buildSegment(params: {
  runId: string;
  index: number;
  avgMinettiGrossPowerWPerKg?: number;
  avgMeasuredPowerWPerKg?: number | null;
  avgHeartRateBpm?: number | null;
  gaitMode?: "run" | "walk";
}): TaggedMonotonicSegment {
  const timeS = 60;
  return {
    runId: params.runId,
    startIndex: params.index,
    endIndex: params.index,
    distance3D: 200,
    timeS,
    avgSpeedMs: 200 / timeS,
    avgGradient: 0,
    gradeSign: 0,
    surfaceCategory: "paved",
    gaitMode: params.gaitMode ?? "run",
    avgMeasuredPowerWPerKg: params.avgMeasuredPowerWPerKg ?? null,
    measuredPowerCoverage: (params.avgMeasuredPowerWPerKg ?? null) !== null ? 1 : 0,
    avgHeartRateBpm: params.avgHeartRateBpm ?? null,
    heartRateCoverage: (params.avgHeartRateBpm ?? null) !== null ? 1 : 0,
    avgMinettiGrossPowerWPerKg: params.avgMinettiGrossPowerWPerKg ?? 10,
    cumulativeElapsedHoursAtStart: params.index * 0.05,
    cumulativeDistanceMAtStart: params.index * 200,
    cumulativeNetWorkJPerKgAtStart: params.index * 50,
    cumulativeHardWorkJPerKgAtStart: params.index * 5,
    cumulativeDescentMAtStart: ((params.index * 13) % 17) * 1.5,
    cumulativeDescentImpactAtStart: ((params.index * 13) % 17) * 3,
    cumulativeDescentImpactSquaredAtStart: ((params.index * 13) % 17) * 6,
    cumulativeRunningImpactAtStart: params.index * 0.5,
  };
}

/** Scrambled (not linear in i) so within-run demeaning doesn't hit an
 * accidental exact-collinearity coincidence -- same lesson learned
 * building intensityConditionedSlowdownFit.test.ts. */
function powerFor(i: number): number {
  return 10 + ((i * 7) % 13) * 0.2;
}

describe("fitSegmentPulseToPower", () => {
  it("recovers an injected bpm-per-W/kg slope against modelled power", () => {
    const trueSlope = 3.5;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 6; r++) {
      const baseline = 130 + r * 4; // each run has its own baseline HR level
      for (let i = 0; i < 15; i++) {
        const power = powerFor(i);
        library.push(
          buildSegment({ runId: `run-${r}`, index: i, avgMinettiGrossPowerWPerKg: power, avgHeartRateBpm: baseline + trueSlope * power }),
        );
      }
    }
    const result = fitSegmentPulseToPower(library, "modelled");
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 3);
    expect(result!.rSquaredWithinRun).toBeGreaterThan(0.99);
  });

  it("is insensitive to a per-run baseline HR shift, thanks to within-run demeaning", () => {
    const trueSlope = 2.0;
    const withoutShift: TaggedMonotonicSegment[] = [];
    const withShift: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 6; r++) {
      for (let i = 0; i < 15; i++) {
        const power = powerFor(i);
        withoutShift.push(buildSegment({ runId: `run-${r}`, index: i, avgMinettiGrossPowerWPerKg: power, avgHeartRateBpm: 140 + trueSlope * power }));
        // Every run's own baseline HR is wildly different -- should have NO
        // effect on the fitted slope/R^2, since each run is demeaned first.
        withShift.push(
          buildSegment({ runId: `run-${r}`, index: i, avgMinettiGrossPowerWPerKg: power, avgHeartRateBpm: 140 + r * 25 + trueSlope * power }),
        );
      }
    }
    const a = fitSegmentPulseToPower(withoutShift, "modelled");
    const b = fitSegmentPulseToPower(withShift, "modelled");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.slope).toBeCloseTo(a!.slope, 6);
    expect(b!.rSquaredWithinRun).toBeCloseTo(a!.rSquaredWithinRun, 6);
  });

  it("reports a low R^2 when heart rate is genuinely unrelated to power", () => {
    // Larger, co-prime-period sample than the other tests here -- both
    // series are deterministic (not random), so a short/small sample can
    // show spurious correlation by coincidence; more points across
    // incommensurate periods averages that down reliably.
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 10; r++) {
      for (let i = 0; i < 60; i++) {
        const hr = 140 + ((i * 5) % 11) * 0.3;
        library.push(buildSegment({ runId: `run-${r}`, index: i, avgMinettiGrossPowerWPerKg: powerFor(i), avgHeartRateBpm: hr }));
      }
    }
    const result = fitSegmentPulseToPower(library, "modelled");
    expect(result).not.toBeNull();
    expect(result!.rSquaredWithinRun).toBeLessThan(0.3);
  });

  it("works against measured power too, independently of the modelled-power basis", () => {
    const trueSlope = 1.5;
    const library: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 6; r++) {
      for (let i = 0; i < 15; i++) {
        const measuredPower = powerFor(i);
        library.push(
          buildSegment({
            runId: `run-${r}`,
            index: i,
            avgMinettiGrossPowerWPerKg: 10, // constant/irrelevant for this basis
            avgMeasuredPowerWPerKg: measuredPower,
            avgHeartRateBpm: 140 + trueSlope * measuredPower,
          }),
        );
      }
    }
    const result = fitSegmentPulseToPower(library, "measured");
    expect(result).not.toBeNull();
    expect(result!.slope).toBeCloseTo(trueSlope, 3);
    expect(result!.rSquaredWithinRun).toBeGreaterThan(0.99);
  });

  it("excludes walk-gait segments and segments missing HR or the chosen power basis", () => {
    const trueSlope = 2.0;
    const clean: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 6; r++) {
      for (let i = 0; i < 15; i++) {
        const power = powerFor(i);
        clean.push(buildSegment({ runId: `run-${r}`, index: i, avgMinettiGrossPowerWPerKg: power, avgHeartRateBpm: 140 + trueSlope * power }));
      }
    }
    const noise: TaggedMonotonicSegment[] = [];
    for (let r = 0; r < 6; r++) {
      noise.push(
        buildSegment({ runId: `run-${r}`, index: 100, avgMinettiGrossPowerWPerKg: 50, avgHeartRateBpm: 200, gaitMode: "walk" }),
        buildSegment({ runId: `run-${r}`, index: 101, avgMinettiGrossPowerWPerKg: 50, avgHeartRateBpm: null }),
      );
    }
    const withoutNoise = fitSegmentPulseToPower(clean, "modelled");
    const withNoise = fitSegmentPulseToPower([...clean, ...noise], "modelled");
    expect(withoutNoise).not.toBeNull();
    expect(withNoise).not.toBeNull();
    expect(withNoise!.segmentCount).toBe(withoutNoise!.segmentCount);
    expect(withNoise!.slope).toBeCloseTo(withoutNoise!.slope, 6);
  });

  it("returns null for an empty library", () => {
    expect(fitSegmentPulseToPower([], "modelled")).toBeNull();
  });

  it("returns null when no run has more than one usable segment", () => {
    const library = [0, 1, 2].map((r) => buildSegment({ runId: `run-${r}`, index: 0, avgHeartRateBpm: 150 }));
    expect(fitSegmentPulseToPower(library, "modelled")).toBeNull();
  });
});
