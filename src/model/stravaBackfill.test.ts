import { describe, expect, it } from "vitest";
import { filterRunsSinceDate, shouldFetchNextBackfillPage, toStoredRunSummaryInput, type StravaRunSummaryDTO } from "./stravaBackfill";

function makeRun(overrides: Partial<StravaRunSummaryDTO> = {}): StravaRunSummaryDTO {
  return {
    id: 1,
    name: "Morning run",
    date: "2025-06-01T08:00:00Z",
    distanceKm: 10,
    movingTimeS: 3000,
    elevationGainM: 100,
    avgHeartRate: 150,
    avgWatts: null,
    ...overrides,
  };
}

describe("shouldFetchNextBackfillPage", () => {
  it("continues when the oldest run in the page is still newer than the target", () => {
    const page = { runs: [makeRun({ date: "2025-06-01" }), makeRun({ date: "2025-05-01" })], hasMore: true };
    expect(shouldFetchNextBackfillPage(page, 1, new Date("2024-01-01"), 50)).toBe(true);
  });

  it("stops once the oldest run in the page is older than the target start date", () => {
    const page = { runs: [makeRun({ date: "2025-06-01" }), makeRun({ date: "2023-01-01" })], hasMore: true };
    expect(shouldFetchNextBackfillPage(page, 1, new Date("2024-01-01"), 50)).toBe(false);
  });

  it("stops when Strava reports no more pages", () => {
    const page = { runs: [makeRun({ date: "2025-06-01" })], hasMore: false };
    expect(shouldFetchNextBackfillPage(page, 1, new Date("2020-01-01"), 50)).toBe(false);
  });

  it("stops at the page cap even if there's more history", () => {
    const page = { runs: [makeRun({ date: "2025-06-01" })], hasMore: true };
    expect(shouldFetchNextBackfillPage(page, 50, new Date("2020-01-01"), 50)).toBe(false);
  });

  it("stops on an empty page", () => {
    const page = { runs: [], hasMore: true };
    expect(shouldFetchNextBackfillPage(page, 1, new Date("2020-01-01"), 50)).toBe(false);
  });
});

describe("filterRunsSinceDate", () => {
  it("drops runs older than the target date", () => {
    const runs = [makeRun({ id: 1, date: "2025-06-01" }), makeRun({ id: 2, date: "2023-01-01" })];
    const filtered = filterRunsSinceDate(runs, new Date("2024-01-01"));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe(1);
  });
});

describe("toStoredRunSummaryInput", () => {
  it("maps the wire DTO onto the storage shape, renaming movingTimeS to durationS", () => {
    const run = makeRun({ id: 42, movingTimeS: 1800 });
    expect(toStoredRunSummaryInput(run)).toEqual({
      stravaId: 42,
      name: "Morning run",
      date: "2025-06-01T08:00:00Z",
      distanceKm: 10,
      durationS: 1800,
      elevationGainM: 100,
      avgHeartRate: 150,
      avgWatts: null,
    });
  });
});
