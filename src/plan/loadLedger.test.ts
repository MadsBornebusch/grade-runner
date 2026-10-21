import { describe, expect, it } from "vitest";
import type { AnalysisSegmentResult } from "../model/analysis";
import {
  activityLoadFromSummary,
  capSpikes,
  spikeReferences,
  dailySeries,
  ewma,
  localDateKey,
  metabolicLoad,
  weekStart,
  type ActivityLoad,
} from "./loadLedger";

function seg(timeS: number, grossPowerWPerKg: number, paused = false): AnalysisSegmentResult {
  return {
    index: 0, cumulativeDistance3D: 0, speedMs: 0, timeS, cumulativeElapsedTimeS: 0, cumulativeMovingTimeS: 0,
    paused, grossPowerWPerKg, carbRateWPerKg: 0, fatRateWPerKg: 0, cumulativeCarbG: 0, cumulativeFatG: 0,
    glycogenG: 0, bonked: false, effortFraction: null,
  };
}

describe("metabolicLoad", () => {
  it("scores one hour at threshold as 100", () => {
    const segments = Array.from({ length: 360 }, () => seg(10, 15));
    expect(metabolicLoad({ segments }, 15)).toBeCloseTo(100, 6);
  });

  it("scales with intensity squared", () => {
    const segments = Array.from({ length: 360 }, () => seg(10, 7.5));
    expect(metabolicLoad({ segments }, 15)).toBeCloseTo(25, 6);
  });

  it("ignores paused segments", () => {
    const moving = Array.from({ length: 360 }, () => seg(10, 15));
    const withPause = [...moving.slice(0, 180), seg(600, 1.2, true), ...moving.slice(180)];
    expect(metabolicLoad({ segments: withPause }, 15)).toBeCloseTo(100, 6);
  });

  it("smooths alternating power before squaring, so noise doesn't inflate the score", () => {
    const noisy = Array.from({ length: 360 }, (_, i) => seg(10, i % 2 === 0 ? 5 : 25));
    const raw = metabolicLoad({ segments: noisy }, 15, 0);
    const smoothed = metabolicLoad({ segments: noisy }, 15);
    expect(raw).toBeGreaterThan(130);
    expect(smoothed).toBeLessThan(105);
  });
});

describe("activityLoadFromSummary", () => {
  it("assumes descent equals gain and grows mechanical load with gain", () => {
    const base = { activityId: "a", date: "2026-04-01", distanceKm: 10, movingS: 3600, thresholdGrossPowerWPerKg: 15 };
    const flat = activityLoadFromSummary({ ...base, elevationGainM: 0 });
    const hilly = activityLoadFromSummary({ ...base, elevationGainM: 500 });
    expect(hilly.descentM).toBe(500);
    expect(hilly.mechanical).toBeGreaterThan(flat.mechanical);
    expect(hilly.metabolic).toBeGreaterThan(flat.metabolic);
    expect(flat.source).toBe("summary");
  });

  it("estimates a larger steep share of descent on hillier-per-km runs, never above the descent", () => {
    const base = { activityId: "a", date: "2026-04-01", movingS: 3600, thresholdGrossPowerWPerKg: 15 };
    const road = activityLoadFromSummary({ ...base, distanceKm: 20, elevationGainM: 200 });
    const trail = activityLoadFromSummary({ ...base, distanceKm: 10, elevationGainM: 800 });
    expect(trail.steepDescentM / trail.descentM).toBeGreaterThan(road.steepDescentM / road.descentM);
    const extreme = activityLoadFromSummary({ ...base, distanceKm: 1, elevationGainM: 500 });
    expect(extreme.steepDescentM).toBe(500);
  });
});

describe("dates", () => {
  it("files a late-evening Oslo run under its local date", () => {
    expect(localDateKey(new Date("2026-04-19T22:30:00Z"), "Europe/Oslo")).toBe("2026-04-20");
    expect(localDateKey(new Date("2026-04-19T22:30:00Z"), "UTC")).toBe("2026-04-19");
  });

  it("finds the Monday of a week", () => {
    expect(weekStart("2026-04-19")).toBe("2026-04-13"); // Sunday
    expect(weekStart("2026-04-13")).toBe("2026-04-13"); // Monday
  });
});

describe("dailySeries", () => {
  it("fills empty days with zero and sums same-day activities", () => {
    const a = (date: string, mechanical: number): ActivityLoad => ({
      activityId: date + mechanical, date, movingS: 0, mechanical, metabolic: 0, descentM: 0, steepDescentM: 0, source: "points",
    });
    const series = dailySeries([a("2026-01-01", 10), a("2026-01-03", 5), a("2026-01-03", 7)], "mechanical", "2026-01-01", "2026-01-04");
    expect(series.map((d) => d.value)).toEqual([10, 0, 12, 0]);
  });
});

describe("ewma", () => {
  it("decays by 41/42 per rest day at tau 42", () => {
    const out = ewma([0, 0], 42, 92);
    expect(out[0]).toBeCloseTo((92 * 41) / 42, 9);
    expect(out[1]).toBeCloseTo((92 * 41 * 41) / (42 * 42), 9);
  });

  it("holds steady when daily load equals the level", () => {
    expect(ewma([60, 60, 60], 42, 60)).toEqual([60, 60, 60]);
  });
});

describe("capSpikes", () => {
  // Ten weeks of SMVE-like training: 60/day with a weekly long run building
  // from 180 to 315. The cap has nothing to compare against in the first
  // weeks of a history, so assertions only look past the first month.
  const build = Array.from({ length: 70 }, (_, d) => (d % 7 === 6 ? 180 + 15 * Math.floor(d / 7) : 60));
  const settled = 35;

  it("lets normal long-run progression and a 1.3x long run through untouched", () => {
    expect(capSpikes(build).slice(settled)).toEqual(build.slice(settled));
    const longRun = 1.3 * Math.max(...build);
    expect(capSpikes([...build, longRun]).at(-1)).toBeCloseTo(longRun, 9);
  });

  it("keeps a 26 h race from inflating the chronic level it prescribes from", () => {
    const values = [...build, 1291, 0, 0];
    const raw = ewma(values, 42, 63);
    const capped = ewma(capSpikes(values), 42, 63);
    const before = raw[build.length - 1];
    expect(raw[build.length] / before).toBeGreaterThan(1.25);
    // At most one big long run's worth of rise.
    expect(capped[build.length] / before).toBeLessThan(1.1);
  });

  it("credits a race as one 10% step when capping the month after it", () => {
    const after = [...build, 1291, ...Array.from({ length: 20 }, () => 60), 1000];
    const raceCredit = 1.1 * Math.max(...build);
    expect(capSpikes(after).at(-1)).toBeCloseTo(1.3 * raceCredit, 9);
  });

  it("measures a comeback long run against the pre-race longest, not the race", () => {
    // The autumn 2025 pattern: a backyard ultra, then four weeks later a long
    // run 28% over the longest pre-race training day.
    const longest = Math.max(...build);
    const values = [...build, 1291, ...Array.from({ length: 27 }, (_, d) => (d % 7 === 6 ? 150 : 50)), 1.28 * longest];
    const { capped, reference } = spikeReferences(values);
    expect(capped.at(-1)).toBeCloseTo(1.28 * longest, 9); // not trimmed
    expect(values.at(-1)! / reference.at(-1)!).toBeGreaterThan(1.1); // but over the guard
  });

  it("doesn't freeze a build of 29% long-run steps", () => {
    const steps = Array.from({ length: 70 }, (_, d) => (d % 7 === 6 ? 150 * 1.29 ** Math.floor(d / 14) : 50));
    expect(capSpikes(steps).slice(settled)).toEqual(steps.slice(settled));
  });

  it("doesn't trim the first runs after a break", () => {
    const values = [...build, ...Array.from({ length: 40 }, () => 0), 80];
    expect(capSpikes(values).at(-1)).toBe(80);
  });

  it("leaves a series with no history uncapped", () => {
    expect(capSpikes([500])).toEqual([500]);
  });
});
