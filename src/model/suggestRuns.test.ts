import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { suggestRunsForFit } from "./suggestRuns";

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: `strava:${overrides.stravaId ?? 1}`,
    name: "Run",
    addedAt: 0,
    points: null,
    durationS: 3600,
    distanceKm: 10,
    avgHeartRate: null,
    avgWatts: null,
    ...overrides,
  };
}

describe("suggestRunsForFit", () => {
  it("excludes runs that already have full points fetched", () => {
    const runs = [makeRun({ id: "a", points: null }), makeRun({ id: "b", points: [] })];
    const { vo2max, durability } = suggestRunsForFit(runs);
    expect(vo2max.every((r) => r.id !== "b")).toBe(true);
    expect(durability.every((r) => r.id !== "b")).toBe(true);
  });

  it("ranks vo2max candidates by power over heart rate over pace, within short-duration runs", () => {
    const highPower = makeRun({ id: "power", durationS: 1800, avgWatts: 300, avgHeartRate: 140 });
    const highHr = makeRun({ id: "hr", durationS: 1800, avgWatts: null, avgHeartRate: 175 });
    const fastPaceOnly = makeRun({ id: "pace", durationS: 1800, distanceKm: 8, avgWatts: null, avgHeartRate: null });
    const suggestions = suggestRunsForFit([fastPaceOnly, highHr, highPower], 3);
    expect(suggestions.vo2max.map((r) => r.id)).toEqual(["power", "hr", "pace"]);
  });

  it("excludes long races from vo2max candidates even if they have high avg watts", () => {
    const longHardRace = makeRun({ id: "ultra", durationS: 8 * 3600, avgWatts: 250 });
    const shortHard = makeRun({ id: "5k", durationS: 1200, avgWatts: 300 });
    const suggestions = suggestRunsForFit([longHardRace, shortHard]);
    expect(suggestions.vo2max.map((r) => r.id)).toEqual(["5k"]);
  });

  it("ranks durability candidates by duration alone, regardless of intensity signal", () => {
    const longEasy = makeRun({ id: "long", durationS: 6 * 3600, avgHeartRate: 120 });
    const shortHard = makeRun({ id: "short", durationS: 1200, avgHeartRate: 180 });
    const suggestions = suggestRunsForFit([shortHard, longEasy]);
    expect(suggestions.durability[0].id).toBe("long");
  });

  it("caps each list at the requested candidate count", () => {
    const runs = Array.from({ length: 10 }, (_, i) => makeRun({ id: `r${i}`, durationS: 1800 + i, avgHeartRate: 150 + i }));
    const suggestions = suggestRunsForFit(runs, 3);
    expect(suggestions.vo2max).toHaveLength(3);
    expect(suggestions.durability).toHaveLength(3);
  });
});
