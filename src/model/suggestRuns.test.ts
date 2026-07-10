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

  it("excludes intervals too short to trust as a near-maximal effort for their own duration", () => {
    const tooShort = makeRun({ id: "sprint", durationS: 5 * 60, avgWatts: 350 });
    const estimable = makeRun({ id: "tempo", durationS: 25 * 60, avgWatts: 300 });
    const suggestions = suggestRunsForFit([tooShort, estimable]);
    expect(suggestions.vo2max.map((r) => r.id)).toEqual(["tempo"]);
  });

  it("ranks durability candidates by duration alone, regardless of intensity signal", () => {
    const longEasy = makeRun({ id: "long", durationS: 6 * 3600, avgHeartRate: 120 });
    const shortHard = makeRun({ id: "short", durationS: 20 * 60, avgHeartRate: 180 });
    const suggestions = suggestRunsForFit([shortHard, longEasy]);
    expect(suggestions.durability[0].id).toBe("long");
  });

  it("excludes runs too short to ever meaningfully inform an ultra-scale tau", () => {
    const genuinelyLong = makeRun({ id: "long", durationS: 3 * 3600 });
    const stillTooShortForTau = makeRun({ id: "short", durationS: 45 * 60 });
    const suggestions = suggestRunsForFit([genuinelyLong, stillTooShortForTau]);
    expect(suggestions.durability.map((r) => r.id)).toEqual(["long"]);
  });

  it("diversifies durability candidates by descent instead of just picking the longest", () => {
    // All well above the duration floor and within a similar duration range,
    // but spanning flat to heavily descending -- the pick should span that
    // range, not collapse to whichever few are longest overall.
    const flat = makeRun({ id: "flat", durationS: 4 * 3600, distanceKm: 40, elevationGainM: 100 });
    const rolling = makeRun({ id: "rolling", durationS: 4 * 3600, distanceKm: 40, elevationGainM: 800 });
    const mountainous = makeRun({ id: "mountainous", durationS: 4 * 3600, distanceKm: 40, elevationGainM: 2400 });
    const suggestions = suggestRunsForFit([flat, rolling, mountainous], 2);
    const ids = suggestions.durability.map((r) => r.id);
    expect(ids).toContain("flat");
    expect(ids).toContain("mountainous");
    expect(ids).not.toContain("rolling");
  });

  it("always keeps the single longest run even when diversifying the rest by descent", () => {
    // The longest run is usually the most responsive for the tau fit -- it
    // should never be dropped in favor of descent variety among shorter
    // (but still long-enough) candidates.
    const longest = makeRun({ id: "longest", durationS: 10 * 3600, distanceKm: 80, elevationGainM: 500 });
    const others = Array.from({ length: 5 }, (_, i) =>
      makeRun({ id: `other${i}`, durationS: 4 * 3600, distanceKm: 40, elevationGainM: i * 400 }),
    );
    const suggestions = suggestRunsForFit([longest, ...others], 3);
    expect(suggestions.durability.map((r) => r.id)).toContain("longest");
  });

  it("caps each list at the requested candidate count", () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun({ id: `r${i}`, durationS: 25 * 60 + i, avgHeartRate: 150 + i }),
    );
    const suggestions = suggestRunsForFit(runs, 3);
    expect(suggestions.vo2max).toHaveLength(3);

    const longRuns = Array.from({ length: 10 }, (_, i) => makeRun({ id: `long${i}`, durationS: 3 * 3600 + i }));
    expect(suggestRunsForFit(longRuns, 3).durability).toHaveLength(3);
  });
});
