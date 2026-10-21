import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { historyRunFromStored, planOptionsFromHistory, type DatedHistoryRun } from "./historyFromRuns";

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
      day: k, date: "", runId: String(k), source: "points", movingMin: 60, distanceKm: 10, mechanical: 60 + k, descentM: 100, steepDescentM: 10,
    }));
    const o = planOptionsFromHistory(runs);
    expect(o.easyDensity).toBe(75);
    expect(o.speedKmh).toBe(10);
  });
});
