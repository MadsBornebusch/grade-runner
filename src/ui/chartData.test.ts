import { describe, expect, it } from "vitest";
import { summarizeChartPoints, type ChartPoint,
  buildGradeHistogram,
} from "./chartData";
import { maxDescentSpeedMs } from "../model/minetti";

function point(overrides: Partial<ChartPoint> = {}): ChartPoint {
  return {
    distanceKm: 0,
    elevationM: 0,
    gradient: 0,
    speedMs: 3,
    mode: "run",
    glycogenG: 500,
    cumulativeTimeS: 0,
    estimatedHeartRateBpm: null,
    ...overrides,
  };
}

describe("summarizeChartPoints", () => {
  it("returns nulls for fewer than 2 points", () => {
    const empty = {
      avgPaceMinPerKm: null,
      avgGapMinPerKm: null,
      avgHrBpm: null,
      avgHrSource: null,
      longestAscent: null,
      longestDescent: null,
      runTimeS: 0,
      walkTimeS: 0,
    };
    expect(summarizeChartPoints([])).toEqual(empty);
    expect(summarizeChartPoints([point()])).toEqual(empty);
  });

  it("computes avg pace as total time over total distance on a flat, constant-speed course", () => {
    // 3 m/s for 3000s -> 9km in 50 minutes -> 5.56 min/km.
    const points = [point({ distanceKm: 0, cumulativeTimeS: 0 }), point({ distanceKm: 9, cumulativeTimeS: 3000, speedMs: 3 })];
    const { avgPaceMinPerKm } = summarizeChartPoints(points);
    expect(avgPaceMinPerKm).toBeCloseTo(3000 / 60 / 9, 6);
  });

  it("GAP equals plain pace on a flat course (grade-adjustment is a no-op at grade 0)", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0, gradient: 0 }),
      point({ distanceKm: 9, cumulativeTimeS: 3000, gradient: 0, speedMs: 3 }),
    ];
    const { avgPaceMinPerKm, avgGapMinPerKm } = summarizeChartPoints(points);
    expect(avgGapMinPerKm).toBeCloseTo(avgPaceMinPerKm!, 6);
  });

  it("GAP reads faster (smaller number) than plain pace on a course run mostly uphill", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0 }),
      point({ distanceKm: 5, cumulativeTimeS: 1800, gradient: 0.1, speedMs: 5000 / 1800 }),
    ];
    const { avgPaceMinPerKm, avgGapMinPerKm } = summarizeChartPoints(points);
    expect(avgGapMinPerKm).toBeLessThan(avgPaceMinPerKm!);
  });

  it("averages estimated HR weighted by segment time, ignoring points with no estimate", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0, estimatedHeartRateBpm: null }),
      // 100s at 140bpm
      point({ distanceKm: 0.3, cumulativeTimeS: 100, estimatedHeartRateBpm: 140 }),
      // 300s at 160bpm (no estimate at this point itself, but the NEXT
      // point's own segment carries no HR either, so this middle point's
      // bpm is what the segment ENDING here contributes)
      point({ distanceKm: 1.3, cumulativeTimeS: 400, estimatedHeartRateBpm: 160 }),
    ];
    const { avgHrBpm } = summarizeChartPoints(points);
    // Segment 1 (0->100s): 140bpm, weight 100. Segment 2 (100->400s): 160bpm, weight 300.
    const expected = (140 * 100 + 160 * 300) / (100 + 300);
    expect(avgHrBpm).toBeCloseTo(expected, 6);
  });

  it("returns null avg HR when no point has an estimate", () => {
    const points = [point({ cumulativeTimeS: 0 }), point({ distanceKm: 1, cumulativeTimeS: 300 })];
    const { avgHrBpm, avgHrSource } = summarizeChartPoints(points);
    expect(avgHrBpm).toBeNull();
    expect(avgHrSource).toBeNull();
  });

  it("reports avgHrSource 'estimated' when every contributing point is a calibration estimate, not a recording", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0 }),
      point({ distanceKm: 0.3, cumulativeTimeS: 100, estimatedHeartRateBpm: 140 }),
    ];
    expect(summarizeChartPoints(points).avgHrSource).toBe("estimated");
  });

  it("reports avgHrSource 'recorded' when every contributing point has a real recorded reading", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0 }),
      point({ distanceKm: 0.3, cumulativeTimeS: 100, recordedHeartRateBpm: 140 }),
    ];
    expect(summarizeChartPoints(points).avgHrSource).toBe("recorded");
  });

  it("reports avgHrSource 'mixed' when some segments are recorded and others fall back to an estimate (e.g. sensor dropout)", () => {
    const points = [
      point({ distanceKm: 0, cumulativeTimeS: 0 }),
      // Segment ending here (0->100s) is a real recording.
      point({ distanceKm: 0.3, cumulativeTimeS: 100, recordedHeartRateBpm: 150 }),
      // Segment ending here (100->400s) has no recording, only an estimate.
      point({ distanceKm: 1.3, cumulativeTimeS: 400, estimatedHeartRateBpm: 160 }),
    ];
    expect(summarizeChartPoints(points).avgHrSource).toBe("mixed");
  });
});

describe("longest ascent / descent", () => {
  /** Points with the given elevation profile, 100m apart, 30s each. */
  function profile(elevations: number[]): ChartPoint[] {
    return elevations.map((elevationM, i) => ({
      distanceKm: (i * 100) / 1000,
      elevationM,
      gradient: 0,
      speedMs: 100 / 30,
      mode: "run" as const,
      glycogenG: 400,
      cumulativeTimeS: i * 30,
      estimatedHeartRateBpm: null,
    }));
  }

  it("finds a single climb's gain and length", () => {
    const stats = summarizeChartPoints(profile([0, 20, 40, 60, 60, 60]));
    expect(stats.longestAscent?.gainM).toBeCloseTo(60, 6);
    expect(stats.longestAscent?.distanceKm).toBeCloseTo(0.3, 6);
    expect(stats.longestAscent?.startKm).toBeCloseTo(0, 6);
  });

  it("picks the LONGEST climb, not the first", () => {
    const stats = summarizeChartPoints(profile([0, 30, 0, 10, 60, 120]));
    expect(stats.longestAscent?.gainM).toBeCloseTo(120, 6);
  });

  it("finds the longest descent as a positive loss", () => {
    const stats = summarizeChartPoints(profile([200, 150, 100, 40, 40]));
    expect(stats.longestDescent?.lossM).toBeCloseTo(160, 6);
    expect(stats.longestDescent?.distanceKm).toBeCloseTo(0.3, 6);
  });

  it("does not let GPS jitter shred one real climb into fragments", () => {
    // A steady climb with metre-scale wobble is one climb, not five.
    const stats = summarizeChartPoints(profile([0, 20, 19, 40, 38, 60, 59, 80]));
    expect(stats.longestAscent?.gainM).toBeCloseTo(80, 6);
  });

  it("ends a climb on a genuinely sustained reversal", () => {
    // Drops 40m in the middle -- well past the noise tolerance, so this is
    // two climbs of 50 and 60, not one of 110.
    const stats = summarizeChartPoints(profile([0, 50, 10, 40, 70]));
    expect(stats.longestAscent?.gainM).toBeCloseTo(60, 6);
  });

  it("reports null on a flat course rather than a zero-length climb", () => {
    const stats = summarizeChartPoints(profile([10, 10, 10, 10]));
    expect(stats.longestAscent).toBeNull();
    expect(stats.longestDescent).toBeNull();
  });
});

describe("run/walk time split", () => {
  function mixed(modes: ("run" | "walk")[]): ChartPoint[] {
    const head: ChartPoint[] = [
      { distanceKm: 0, elevationM: 0, gradient: 0, speedMs: 3, mode: "run", glycogenG: 400, cumulativeTimeS: 0, estimatedHeartRateBpm: null },
    ];
    return head.concat(
      modes.map((mode, i) => ({
        distanceKm: (i + 1) / 10,
        elevationM: 0,
        gradient: 0,
        speedMs: 3,
        mode,
        glycogenG: 400,
        cumulativeTimeS: (i + 1) * 60,
        estimatedHeartRateBpm: null,
      })),
    );
  }

  it("splits time by gait and accounts for all of it", () => {
    const stats = summarizeChartPoints(mixed(["run", "walk", "walk", "run"]));
    expect(stats.runTimeS).toBeCloseTo(120, 6);
    expect(stats.walkTimeS).toBeCloseTo(120, 6);
  });

  it("puts everything in run time when nothing is walked", () => {
    const stats = summarizeChartPoints(mixed(["run", "run"]));
    expect(stats.walkTimeS).toBe(0);
    expect(stats.runTimeS).toBeCloseTo(120, 6);
  });
});

describe("buildGradeHistogram", () => {
  function graded(specs: { gradient: number; speedMs: number; mode?: "run" | "walk" }[]): ChartPoint[] {
    const pts: ChartPoint[] = [
      { distanceKm: 0, elevationM: 0, gradient: 0, speedMs: 3, mode: "run" as const, glycogenG: 400, cumulativeTimeS: 0, estimatedHeartRateBpm: null },
    ];
    specs.forEach((s, i) => {
      pts.push({
        distanceKm: (i + 1) / 10,
        elevationM: 0,
        gradient: s.gradient,
        speedMs: s.speedMs,
        mode: s.mode ?? "run",
        glycogenG: 400,
        cumulativeTimeS: (i + 1) * 40,
        estimatedHeartRateBpm: null,
      });
    });
    return pts;
  }

  it("buckets distance by gradient and omits empty bins", () => {
    const bins = buildGradeHistogram(graded([{ gradient: 0.01, speedMs: 3 }, { gradient: 0.011, speedMs: 3 }]), 10);
    expect(bins).toHaveLength(1);
    expect(bins[0].distanceM).toBeCloseTo(200, 6);
  });

  it("flags the uphill bins where the plan walks", () => {
    const bins = buildGradeHistogram(
      graded([{ gradient: 0.3, speedMs: 1, mode: "walk" }, { gradient: 0.01, speedMs: 3 }]),
      10,
    );
    expect(bins.find((b) => b.fromGradient >= 0.3)!.hasWalking).toBe(true);
    expect(bins.find((b) => b.fromGradient === 0)!.hasWalking).toBe(false);
  });

  it("flags a descent bin as braking only when the cap is what bound it", () => {
    const totalKm = 10;
    const gradient = -0.2;
    const cap = maxDescentSpeedMs(gradient, totalKm);
    const atCap = buildGradeHistogram(graded([{ gradient, speedMs: cap }]), totalKm);
    expect(atCap[0].hasBraking).toBe(true);
    // Comfortably under the cap -- power-limited, not braking.
    const underCap = buildGradeHistogram(graded([{ gradient, speedMs: cap * 0.5 }]), totalKm);
    expect(underCap[0].hasBraking).toBe(false);
  });

  it("returns bins in ascending gradient order", () => {
    const bins = buildGradeHistogram(
      graded([{ gradient: 0.2, speedMs: 2 }, { gradient: -0.2, speedMs: 2 }, { gradient: 0, speedMs: 3 }]),
      10,
    );
    expect(bins.map((b) => b.fromGradient)).toEqual([...bins.map((b) => b.fromGradient)].sort((a, b) => a - b));
  });
});
