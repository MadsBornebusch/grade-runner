import { describe, expect, it } from "vitest";
import { isDueForFetch, isPermanentFetchFailure, MAX_FETCH_FAILURES } from "./autoFetchRuns";
import { PERMANENT_FETCH_FAILURE_COUNT, type StoredRun } from "../storage/runLibrary";
import { StravaFetchError } from "./stravaClient";

const run = (over: Partial<StoredRun> = {}): StoredRun =>
  ({ id: "r", name: "Run", points: null, wantsFullData: true, ...over }) as StoredRun;

describe("isDueForFetch", () => {
  const NOW = 1_700_000_000_000;

  it("fetches a run that has never failed", () => {
    expect(isDueForFetch(run(), NOW)).toBe(true);
  });

  it("backs off right after a first failure instead of retrying next launch", () => {
    // The reported bug: dozens of runs re-queued on every app open.
    expect(isDueForFetch(run({ fetchFailureCount: 1, lastFetchFailureAt: NOW - 60_000 }), NOW)).toBe(false);
  });

  it("retries once the backoff for that failure count has elapsed", () => {
    const overAnHour = NOW - 2 * 60 * 60 * 1000;
    expect(isDueForFetch(run({ fetchFailureCount: 1, lastFetchFailureAt: overAnHour }), NOW)).toBe(true);
  });

  it("lengthens the backoff with each successive failure", () => {
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    // Due after 1h at one failure, but two failures means waiting a day.
    expect(isDueForFetch(run({ fetchFailureCount: 1, lastFetchFailureAt: twoHoursAgo }), NOW)).toBe(true);
    expect(isDueForFetch(run({ fetchFailureCount: 2, lastFetchFailureAt: twoHoursAgo }), NOW)).toBe(false);
  });

  it("drops a permanently-broken run from the auto batch entirely", () => {
    const longAgo = NOW - 365 * 24 * 60 * 60 * 1000;
    expect(isDueForFetch(run({ fetchFailureCount: MAX_FETCH_FAILURES, lastFetchFailureAt: longAgo }), NOW)).toBe(false);
  });

  it("treats a missing lastFetchFailureAt as long overdue rather than never retrying", () => {
    expect(isDueForFetch(run({ fetchFailureCount: 1 }), NOW)).toBe(true);
  });
});

describe("isPermanentFetchFailure", () => {
  it("treats an activity with no GPS data as permanent", () => {
    // These were the bulk of the "M failed. Try again shortly" count: the
    // candidate list was drawn partly from a title heuristic that matches
    // any renamed activity, so it queued treadmill runs, indoor sessions
    // and strength workouts that never had GPS to give. Retrying those on
    // the 1h/1d/1w backoff re-asks a question whose answer cannot change.
    expect(isPermanentFetchFailure(new StravaFetchError("no GPS", 422))).toBe(true);
  });

  it("treats an activity that is gone from Strava as permanent", () => {
    expect(isPermanentFetchFailure(new StravaFetchError("gone", 404))).toBe(true);
  });

  it("does NOT treat a rate limit as permanent -- that is the most retryable failure there is", () => {
    expect(isPermanentFetchFailure(new StravaFetchError("slow down", 429))).toBe(false);
  });

  it("does NOT treat an expired session as permanent -- reconnecting fixes it", () => {
    expect(isPermanentFetchFailure(new StravaFetchError("expired", 401))).toBe(false);
  });

  it("does NOT treat an upstream fault as permanent", () => {
    expect(isPermanentFetchFailure(new StravaFetchError("bad gateway", 502))).toBe(false);
  });

  it("does not choke on a non-Strava error (a network drop, say)", () => {
    expect(isPermanentFetchFailure(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("writes a failure count that isDueForFetch actually treats as final", () => {
    // The two constants live in different layers (storage must not import
    // the UI module), so nothing but this check keeps them consistent --
    // a PERMANENT_FETCH_FAILURE_COUNT below MAX_FETCH_FAILURES would
    // silently put permanently-dead runs back in the batch.
    expect(PERMANENT_FETCH_FAILURE_COUNT).toBeGreaterThanOrEqual(MAX_FETCH_FAILURES);
    expect(
      isDueForFetch({ ...run({ fetchFailureCount: PERMANENT_FETCH_FAILURE_COUNT, lastFetchFailureAt: 0 }) }, 1e15),
    ).toBe(false);
  });
});
