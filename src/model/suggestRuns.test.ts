import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/runLibrary";
import { selectFetchCandidateIds, suggestRunsForFit } from "./suggestRuns";

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

  it("keeps a duration standout in the durability bucket even when its own descent profile is unremarkable", () => {
    // Regression test: scripts/diagnoseBackyardMissing.ts found a real 13.7h
    // backyard ultra -- a genuine duration standout, second only to the
    // single longest race -- silently missing from every suggestRunsForFit
    // bucket, because the old "only the single longest run is duration-
    // exempt" rule left every other long run to compete purely on
    // descent/km, where it landed at a middling, unremarkable value and
    // simply wasn't hit by the evenly-spaced descent sampling.
    const longest = makeRun({ id: "longest", durationS: 20 * 3600, distanceKm: 150, elevationGainM: 1000 });
    const standout = makeRun({ id: "standout", durationS: 10 * 3600, distanceKm: 50, elevationGainM: 600 }); // descent/km = 12, strictly between the others below
    const others = [0, 200, 400, 600, 800].map((elevationGainM, i) =>
      makeRun({ id: `other${i}`, durationS: 8 * 3600, distanceKm: 40, elevationGainM }),
    ); // descent/km = 0, 5, 10, 15, 20
    const suggestions = suggestRunsForFit([longest, standout, ...others], 3);
    expect(suggestions.durability.map((r) => r.id)).toContain("standout");
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

  describe("durationSpread", () => {
    it("picks the longest race plus a meaningfully shorter one", () => {
      const ultra = makeRun({ id: "ultra", durationS: 20 * 3600 });
      const marathon = makeRun({ id: "marathon", durationS: 4 * 3600 });
      const suggestions = suggestRunsForFit([ultra, marathon]);
      expect(suggestions.durationSpread.map((r) => r.id)).toEqual(["ultra", "marathon"]);
    });

    it("excludes races too close in duration to the longest to give real spread", () => {
      const longest = makeRun({ id: "longest", durationS: 10 * 3600 });
      const almostAsLong = makeRun({ id: "similar", durationS: 8 * 3600 });
      const suggestions = suggestRunsForFit([longest, almostAsLong]);
      expect(suggestions.durationSpread.map((r) => r.id)).toEqual(["longest"]);
    });

    it("excludes a shorter candidate that's too brief to be a genuine race effort", () => {
      const longest = makeRun({ id: "longest", durationS: 10 * 3600 });
      const tooShort = makeRun({ id: "sprint", durationS: 5 * 60 });
      const suggestions = suggestRunsForFit([longest, tooShort]);
      expect(suggestions.durationSpread.map((r) => r.id)).toEqual(["longest"]);
    });

    it("returns nothing when there's no unfetched run at all", () => {
      const fetched = makeRun({ id: "already-fetched", points: [], durationS: 10 * 3600 });
      expect(suggestRunsForFit([fetched]).durationSpread).toEqual([]);
    });

    it("prefers the longest among qualifying shorter candidates, for maximum signal", () => {
      const ultra = makeRun({ id: "ultra", durationS: 20 * 3600 });
      const shortA = makeRun({ id: "shortA", durationS: 2 * 3600 });
      const shortB = makeRun({ id: "shortB", durationS: 4 * 3600 });
      const suggestions = suggestRunsForFit([ultra, shortA, shortB], 2);
      expect(suggestions.durationSpread.map((r) => r.id)).toEqual(["ultra", "shortB"]);
    });
  });

  describe("namedRace", () => {
    it("suggests non-generic-titled runs regardless of duration", () => {
      const shortRace = makeRun({ id: "race", name: "Askerspurten 10 km", durationS: 25 * 60 });
      const genericLong = makeRun({ id: "generic", name: "Morning Trail Run", durationS: 5 * 3600 });
      const suggestions = suggestRunsForFit([shortRace, genericLong]);
      expect(suggestions.namedRace.map((r) => r.id)).toEqual(["race"]);
    });

    it("still excludes runs that already have full points fetched", () => {
      const fetchedRace = makeRun({ id: "race", name: "Ecotrail 80", points: [] });
      expect(suggestRunsForFit([fetchedRace]).namedRace).toEqual([]);
    });

    it("caps at candidateCount", () => {
      const races = Array.from({ length: 5 }, (_, i) => makeRun({ id: `race-${i}`, name: `Race ${i}` }));
      expect(suggestRunsForFit(races, 2).namedRace).toHaveLength(2);
    });
  });
});

describe("selectFetchCandidateIds", () => {
  // A library that looks like the one that produced the bug: plenty of
  // runs, all renamed by the athlete, so the namedRace title heuristic
  // matches every single one.
  function namedLibrary(count: number, overrides: (i: number) => Partial<StoredRun> = () => ({})) {
    return Array.from({ length: count }, (_, i) =>
      makeRun({
        id: `run-${i}`,
        name: `Tempo w/ the club ${i}`,
        durationS: 1800 + i * 300,
        distanceKm: 8 + i,
        avgHeartRate: 150 + (i % 20),
        ...overrides(i),
      }),
    );
  }

  it("never marks more than the cap, even when every run has a real-looking name", () => {
    // The reported bug: namedRace had its own budget on top of the cap, and
    // the title heuristic matches any renamed run, so a 200-run library of
    // named workouts marked ~2x the cap (122 against a cap of 60).
    const ids = selectFetchCandidateIds(namedLibrary(200), 60, 60);
    expect(ids.length).toBeLessThanOrEqual(60);
  });

  it("counts runs already marked against the cap, so the marked set converges", () => {
    const runs = namedLibrary(200).map((r, i) => (i < 55 ? { ...r, wantsFullData: true } : r));
    expect(selectFetchCandidateIds(runs, 60, 60)).toHaveLength(5);
  });

  it("marks nothing once the cap is already spent", () => {
    const runs = namedLibrary(200).map((r, i) => (i < 60 ? { ...r, wantsFullData: true } : r));
    expect(selectFetchCandidateIds(runs, 60, 60)).toEqual([]);
  });

  it("marks nothing when the library is already over the cap", () => {
    // What this athlete's library is in right now: 122 already marked
    // against a cap of 60. The fix has to stop the set growing, not go
    // negative or throw.
    const runs = namedLibrary(200).map((r, i) => (i < 122 ? { ...r, wantsFullData: true } : r));
    expect(selectFetchCandidateIds(runs, 60, 60)).toEqual([]);
  });

  it("does not ratchet: downloading marked runs must not free slots for new ones", () => {
    // The loop the athlete actually saw. Every successful download drops a
    // run out of suggestRunsForFit's `unfetched` pool; if the cap only
    // bounded a single pass, the freed slot went to the next-ranked run on
    // the next Settings open, and "needs to download N" refilled forever.
    let runs: StoredRun[] = namedLibrary(200);
    const marked = new Set(selectFetchCandidateIds(runs, 60, 60));
    expect(marked.size).toBe(60);
    runs = runs.map((r) => (marked.has(r.id) ? { ...r, wantsFullData: true } : r));

    // Half of them finish downloading, then Settings is reopened (which
    // re-runs the marking).
    let downloaded = 0;
    runs = runs.map((r) => (r.wantsFullData && downloaded++ < 30 ? { ...r, points: [] } : r));
    expect(selectFetchCandidateIds(runs, 60, 60)).toEqual([]);
  });

  it("never re-marks a run that is already marked", () => {
    const runs = namedLibrary(100).map((r, i) => (i % 2 === 0 ? { ...r, wantsFullData: true } : r));
    const already = new Set(runs.filter((r) => r.wantsFullData).map((r) => r.id));
    expect(selectFetchCandidateIds(runs, 100, 60).some((id) => already.has(id))).toBe(false);
  });

  it("does not spend two budget slots on one run picked by two buckets", () => {
    // A single long run is both the durability pick and the duration-spread
    // anchor; counting it twice would silently under-fill the batch.
    const runs = [
      makeRun({ id: "ultra", name: "Soria Moria 168", durationS: 24 * 3600, distanceKm: 168 }),
      ...namedLibrary(20, () => ({})),
    ];
    const ids = selectFetchCandidateIds(runs, 10, 60);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });
});
