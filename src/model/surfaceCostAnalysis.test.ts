import { describe, expect, it } from "vitest";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { buildSurfaceCostTable, summarizeAcrossGradeBins } from "./surfaceCostAnalysis";
import { costOfRunning } from "./minetti";
import { grossToNet } from "./energetics";

function taggedSeg(overrides: Partial<TaggedMonotonicSegment> = {}): TaggedMonotonicSegment {
  return {
    runId: "run-1",
    startIndex: 0,
    endIndex: 0,
    distance3D: 150,
    timeS: 60,
    avgSpeedMs: 2.5,
    avgGradient: 0,
    gradeSign: 0,
    surfaceCategory: "paved",
    gaitMode: "run",
    avgMeasuredPowerWPerKg: 15,
    measuredPowerCoverage: 1,
    avgHeartRateBpm: null,
    heartRateCoverage: 0,
    avgMinettiGrossPowerWPerKg: 12,
    cumulativeElapsedHoursAtStart: 0,
    cumulativeDistanceMAtStart: 0,
    cumulativeNetWorkJPerKgAtStart: 0,
    cumulativeHardWorkJPerKgAtStart: null,
    cumulativeDescentMAtStart: 0,
    cumulativeDescentImpactAtStart: 0,
    cumulativeDescentImpactSquaredAtStart: 0,
    cumulativeRunningImpactAtStart: 0,
    ...overrides,
  };
}

/** Predicted speed the model itself would derive from a given segment's own
 * avgMeasuredPowerWPerKg/avgGradient at calibration=1 -- lets tests set an
 * exact actual speed as a known multiple of it, rather than hardcoding a
 * decimal that could hide an arithmetic mistake. */
function modelPredictedSpeedMs(measuredPowerWPerKg: number, gradient: number): number {
  return grossToNet(measuredPowerWPerKg) / costOfRunning(gradient);
}

describe("buildSurfaceCostTable", () => {
  it("recovers an injected cost multiplier within a single grade bin at matched power", () => {
    const predictedSpeed = modelPredictedSpeedMs(15, 0);
    const segments = [
      taggedSeg({ runId: "a", surfaceCategory: "paved", avgSpeedMs: predictedSpeed }),
      taggedSeg({ runId: "b", surfaceCategory: "gravel", avgSpeedMs: predictedSpeed * 0.85 }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    const gravelCell = table.find((c) => c.surfaceCategory === "gravel")!;
    expect(gravelCell.relativeToPavedLogSpeedResidual).toBeCloseTo(Math.log(0.85), 10);
    expect(gravelCell.impliedCostMultiplierVsPaved).toBeCloseTo(1 / 0.85, 6);
  });

  it("does not report a spurious effect when a category never overlaps paved in any grade bin", () => {
    const segments = [
      taggedSeg({ runId: "a", surfaceCategory: "paved", avgGradient: 0 }),
      taggedSeg({ runId: "b", surfaceCategory: "gravel", avgGradient: 0.2, avgSpeedMs: modelPredictedSpeedMs(15, 0.2) * 0.5 }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    const gravelCell = table.find((c) => c.surfaceCategory === "gravel")!;
    expect(gravelCell.relativeToPavedLogSpeedResidual).toBeNull();
    expect(gravelCell.impliedCostMultiplierVsPaved).toBeNull();

    const summary = summarizeAcrossGradeBins(table).find((s) => s.surfaceCategory === "gravel")!;
    expect(summary.comparableSegmentCount).toBe(0);
    expect(summary.meanRelativeToPavedLogSpeedResidual).toBeNull();
  });

  it("counts distinct runs per cell, not segments", () => {
    const segments = [
      taggedSeg({ runId: "same-run", surfaceCategory: "gravel" }),
      taggedSeg({ runId: "same-run", surfaceCategory: "gravel" }),
      taggedSeg({ runId: "same-run", surfaceCategory: "gravel" }),
      taggedSeg({ runId: "other-run", surfaceCategory: "gravel" }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    const cell = table.find((c) => c.surfaceCategory === "gravel")!;
    expect(cell.segmentCount).toBe(4);
    expect(cell.runCount).toBe(2);
  });

  it("excludes walk-gait segments by default, includes them when runningGaitOnly is false", () => {
    const segments = [
      taggedSeg({ runId: "a", surfaceCategory: "paved" }),
      taggedSeg({ runId: "b", surfaceCategory: "gravel", gaitMode: "walk" }),
    ];
    const defaultTable = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    expect(defaultTable.find((c) => c.surfaceCategory === "gravel")).toBeUndefined();

    const walkInclusiveTable = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1, runningGaitOnly: false });
    expect(walkInclusiveTable.find((c) => c.surfaceCategory === "gravel")).toBeDefined();
  });

  it("ignores segments with no device power", () => {
    const segments = [
      taggedSeg({ runId: "a", surfaceCategory: "paved" }),
      taggedSeg({ runId: "b", surfaceCategory: "gravel", avgMeasuredPowerWPerKg: null }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    expect(table.find((c) => c.surfaceCategory === "gravel")).toBeUndefined();
  });

  it("ignores segments with no surface data", () => {
    const segments = [
      taggedSeg({ runId: "a", surfaceCategory: "paved" }),
      taggedSeg({ runId: "b", surfaceCategory: undefined }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    expect(table).toHaveLength(1);
    expect(table[0].surfaceCategory).toBe("paved");
  });
});

describe("summarizeAcrossGradeBins", () => {
  it("pools per-bin comparisons weighted by segment count", () => {
    const predictedFlat = modelPredictedSpeedMs(15, 0);
    const predictedClimb = modelPredictedSpeedMs(15, 0.1);
    const segments = [
      // flat bin: paved baseline, gravel 20% slower, 1 segment
      taggedSeg({ runId: "a", surfaceCategory: "paved", avgGradient: 0, avgSpeedMs: predictedFlat }),
      taggedSeg({ runId: "b", surfaceCategory: "gravel", avgGradient: 0, avgSpeedMs: predictedFlat * 0.8 }),
      // climb bin: paved baseline, gravel 10% slower, 3 segments (more weight)
      taggedSeg({ runId: "c", surfaceCategory: "paved", avgGradient: 0.1, avgSpeedMs: predictedClimb }),
      taggedSeg({ runId: "d", surfaceCategory: "gravel", avgGradient: 0.1, avgSpeedMs: predictedClimb * 0.9 }),
      taggedSeg({ runId: "e", surfaceCategory: "gravel", avgGradient: 0.1, avgSpeedMs: predictedClimb * 0.9 }),
      taggedSeg({ runId: "f", surfaceCategory: "gravel", avgGradient: 0.1, avgSpeedMs: predictedClimb * 0.9 }),
    ];
    const table = buildSurfaceCostTable(segments, { strydToMinettiCalibration: 1 });
    const summary = summarizeAcrossGradeBins(table).find((s) => s.surfaceCategory === "gravel")!;

    const expectedWeightedRelative = (Math.log(0.8) * 1 + Math.log(0.9) * 3) / 4;
    expect(summary.comparableSegmentCount).toBe(4);
    expect(summary.comparableBinCount).toBe(2);
    expect(summary.meanRelativeToPavedLogSpeedResidual).toBeCloseTo(expectedWeightedRelative, 10);
  });
});
