import { describe, expect, it } from "vitest";
import { isDueForFetch, MAX_FETCH_FAILURES } from "./autoFetchRuns";
import type { StoredRun } from "../storage/runLibrary";

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
