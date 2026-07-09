// Pure helpers for bulk-backfilling Strava run summaries -- the actual
// paging loop lives in RunLibraryPanel.tsx (it has to call fetch()), but the
// stop-condition and mapping logic are pulled out here so they're testable
// without mocking HTTP.

import type { StravaRunSummaryInput } from "../storage/runLibrary";

export interface StravaRunSummaryDTO {
  id: number;
  name: string;
  date: string;
  distanceKm: number;
  movingTimeS: number;
  elevationGainM: number;
  avgHeartRate: number | null;
  avgWatts: number | null;
}

export interface BackfillPage {
  runs: StravaRunSummaryDTO[];
  hasMore: boolean;
}

/**
 * Decides whether the backfill loop should fetch another page. Strava
 * returns activities most-recent-first, so the last run in a page is the
 * oldest one seen so far -- once that's older than the target start date,
 * every subsequent page would only be older still.
 */
export function shouldFetchNextBackfillPage(
  page: BackfillPage,
  pagesFetchedSoFar: number,
  targetStartDate: Date,
  maxPages: number,
): boolean {
  if (pagesFetchedSoFar >= maxPages) return false;
  if (!page.hasMore) return false;
  if (page.runs.length === 0) return false;
  const oldestInPage = page.runs[page.runs.length - 1];
  return new Date(oldestInPage.date) > targetStartDate;
}

/** The last page fetched will usually straddle the cutoff -- drop runs
 * older than the target date before storing. */
export function filterRunsSinceDate(runs: StravaRunSummaryDTO[], targetStartDate: Date): StravaRunSummaryDTO[] {
  return runs.filter((r) => new Date(r.date) >= targetStartDate);
}

export function toStoredRunSummaryInput(run: StravaRunSummaryDTO): StravaRunSummaryInput {
  return {
    stravaId: run.id,
    name: run.name,
    date: run.date,
    distanceKm: run.distanceKm,
    durationS: run.movingTimeS,
    elevationGainM: run.elevationGainM,
    avgHeartRate: run.avgHeartRate,
    avgWatts: run.avgWatts,
  };
}
