import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { dedupeStoredRuns } from "./dedupeRuns";

function summaryRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: "strava:1",
    name: "Ecotrail 80",
    addedAt: 0,
    points: null,
    stravaId: 1,
    date: "2025-06-01T08:00:00Z",
    distanceKm: 77.8,
    durationS: 8.5 * 3600,
    ...overrides,
  };
}

// ~1 degree of latitude = 111.32 km -- placed so the two-point haversine
// distance below comes out to ~77.8km, matching summaryRun's stated distance.
const GPX_LAT_SPAN = 77.8 / 111.32;

function gpxRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const start = new Date("2025-06-01T08:00:00Z");
  const end = new Date(start.getTime() + 8.5 * 3600 * 1000);
  return {
    id: "manual-uuid-1",
    name: "Ecotrail 80.gpx",
    addedAt: 0,
    points: [
      { lat: 60, lon: 10, ele: 0, time: start, hr: null, power: null },
      { lat: 60 + GPX_LAT_SPAN, lon: 10, ele: 0, time: end, hr: null, power: null },
    ],
    ...overrides,
  };
}

describe("dedupeStoredRuns", () => {
  it("matches a GPX upload with real rest stops against Strava's moving-time duration", () => {
    // The GPX signature's duration is raw elapsed time (first point to last);
    // Strava's durationS is *moving* time, which excludes rest stops -- for
    // an ultra with aid-station stops those legitimately differ by well more
    // than a couple of minutes for the very same activity.
    const gpxWithRestStops = gpxRun({
      id: "manual-uuid-rest",
      points: [
        { lat: 60, lon: 10, ele: 0, time: new Date("2025-06-01T08:00:00Z"), hr: null, power: null },
        // 8.5h elapsed + 20min of aid-station stops baked into the raw span.
        { lat: 60 + GPX_LAT_SPAN, lon: 10, ele: 0, time: new Date("2025-06-01T16:50:00Z"), hr: null, power: null },
      ],
    });
    const stravaSummary = summaryRun(); // durationS = 8.5h moving time
    const result = dedupeStoredRuns([gpxWithRestStops, stravaSummary]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicateGroups).toHaveLength(1);
  });

  it("catches a manual GPX upload and a later Strava backfill of the same activity", () => {
    const manual = gpxRun();
    const stravaSummary = summaryRun();
    const result = dedupeStoredRuns([manual, stravaSummary]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicateGroups).toHaveLength(1);
  });

  it("prefers the Strava-sourced copy (richer metadata) when both have full points", () => {
    const manual = gpxRun({ id: "manual-uuid-2" });
    const stravaWithPoints = summaryRun({ id: "strava:2", stravaId: 2, points: manual.points });
    const result = dedupeStoredRuns([manual, stravaWithPoints]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].id).toBe("strava:2");
  });

  it("does not merge two genuinely different runs on different days", () => {
    const runA = summaryRun({ id: "strava:1", date: "2025-06-01T08:00:00Z" });
    const runB = summaryRun({ id: "strava:2", stravaId: 2, date: "2025-06-08T08:00:00Z" });
    const result = dedupeStoredRuns([runA, runB]);
    expect(result.kept).toHaveLength(2);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("does not merge two same-day runs with meaningfully different distance", () => {
    const runA = summaryRun({ id: "strava:1", distanceKm: 10 });
    const runB = summaryRun({ id: "strava:2", stravaId: 2, distanceKm: 25 });
    const result = dedupeStoredRuns([runA, runB]);
    expect(result.kept).toHaveLength(2);
  });

  it("leaves runs with no derivable signature untouched (no false merge)", () => {
    const noTimestamps = gpxRun({
      id: "no-time",
      points: [{ lat: 60, lon: 10, ele: 0, time: null, hr: null, power: null }],
    });
    const result = dedupeStoredRuns([noTimestamps]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("groups 3+ copies of the same activity together", () => {
    const a = summaryRun({ id: "strava:1" });
    const b = summaryRun({ id: "strava:2", stravaId: 2 });
    const c = gpxRun({ id: "manual-3" });
    const result = dedupeStoredRuns([a, b, c]);
    expect(result.kept).toHaveLength(1);
    expect(result.duplicateGroups[0]).toHaveLength(3);
  });
});
