import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { treadmillCandidates } from "./suggestRuns";

const now = Date.parse("2026-06-01T12:00:00Z");
const run = (id: string, daysAgo: number, over: Partial<StoredRun> = {}): StoredRun => ({
  id, name: id, addedAt: 0, points: null, stravaId: 1, date: new Date(now - daysAgo * 864e5).toISOString(), elevationGainM: 120, ...over,
});

describe("treadmillCandidates", () => {
  it("lists recent summary-only runs that look indoor, newest first", () => {
    const runs = [
      run("flagged", 3, { indoor: true }),
      run("no-gain", 1, { elevationGainM: 0 }),
      run("outdoor", 2),
      run("with-points", 2, { indoor: true, points: [] }),
      run("old", 120, { indoor: true }),
      run("gpx", 1, { indoor: true, stravaId: undefined }),
    ];
    expect(treadmillCandidates(runs, now).map((r) => r.id)).toEqual(["no-gain", "flagged"]);
  });
});
