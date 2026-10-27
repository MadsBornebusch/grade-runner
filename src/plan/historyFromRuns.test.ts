import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { historyRunFromStored, planOptionsFromHistory, treadmillLoad, type DatedHistoryRun } from "./historyFromRuns";
import { DEFAULT_RUNNING_IMPACT_COEFFICIENTS } from "../model/runningImpact";

const summaryRun = (over: Partial<StoredRun> = {}): StoredRun => ({
  id: "strava:1", name: "Evening Run", addedAt: 0, points: null, date: "2026-04-19T20:30:00Z", distanceKm: 10, durationS: 3600, elevationGainM: 200, ...over,
});

describe("historyRunFromStored", () => {
  it("files a summary run under its local date with the summary load", () => {
    const h = historyRunFromStored(summaryRun({ date: "2026-04-19T22:30:00Z" }), "Europe/Oslo")!;
    expect(h.date).toBe("2026-04-20");
    expect(h.source).toBe("summary");
    expect(h.descentM).toBe(200);
    expect(h.movingMin).toBe(60);
    expect(h.mechanical).toBeGreaterThan(60);
  });

  it("skips runs without a date or distance", () => {
    expect(historyRunFromStored(summaryRun({ date: undefined }), "UTC")).toBeNull();
    expect(historyRunFromStored(summaryRun({ distanceKm: 0 }), "UTC")).toBeNull();
  });
});

describe("planOptionsFromHistory", () => {
  it("uses generic values until there are enough points-based runs", () => {
    expect(planOptionsFromHistory([]).easyDensity).toBe(70);
    const runs: DatedHistoryRun[] = Array.from({ length: 30 }, (_, k) => ({
      day: k, date: "", runId: String(k), source: "points", movingMin: 60, distanceKm: 10, mechanical: 60 + k, descentM: 100, steepDescentM: 10, climbM: 100,
    }));
    const o = planOptionsFromHistory(runs);
    expect(o.easyDensity).toBe(75);
    expect(o.speedKmh).toBe(10);
  });
});

describe("treadmill laps", () => {
  it("climbs and descends with each lap's grade, along the belt", () => {
    const flat = treadmillLoad([{ distanceM: 2000, movingS: 600, gradePct: 0 }]);
    expect(flat).toMatchObject({ climbM: 0, descentM: 0, steepDescentM: 0 });
    expect(flat.mechanical).toBeCloseTo(2 * DEFAULT_RUNNING_IMPACT_COEFFICIENTS.distanceCoefficient, 6);
    const hilly = treadmillLoad([
      { distanceM: 1000, movingS: 300, gradePct: 0 },
      { distanceM: 1000, movingS: 400, gradePct: 10 },
      { distanceM: 500, movingS: 200, gradePct: -20 },
    ]);
    expect(hilly.climbM).toBeCloseTo(1000 * 0.1 / Math.sqrt(1.01), 6);
    expect(hilly.descentM).toBeCloseTo(500 * 0.2 / Math.sqrt(1.04), 6);
    expect(hilly.steepDescentM).toBeCloseTo(hilly.descentM, 6);
    expect(hilly.mechanical).toBeGreaterThan(treadmillLoad([{ distanceM: 2500, movingS: 900, gradePct: 0 }]).mechanical);
  });

  it("uses the laps for a run without points", () => {
    const h = historyRunFromStored(summaryRun({ elevationGainM: 0, treadmillLaps: [{ distanceM: 10000, movingS: 3600, gradePct: 5 }] }), "Europe/Oslo")!;
    expect(h.source).toBe("laps");
    expect(h.climbM).toBeCloseTo(10000 * 0.05 / Math.sqrt(1.0025), 6);
    expect(historyRunFromStored(summaryRun({ elevationGainM: 0 }), "Europe/Oslo")!.climbM).toBe(0);
  });
});
