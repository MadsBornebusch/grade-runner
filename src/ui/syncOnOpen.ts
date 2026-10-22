import { runBackfillBatch } from "./backfillRuns";

/** Persists the backfill "from" date across sessions (same localStorage
 * pattern as formInputs.ts's own settings) -- so a returning user doesn't
 * have to remember or re-enter it, and clicking the same button again
 * naturally becomes an incremental update: after a successful backfill,
 * this is advanced to today, so next time there's nothing to re-scan
 * except whatever's genuinely new since then. */
const LAST_BACKFILL_DATE_STORAGE_KEY = "grade-runner:lastBackfillDate";

export function loadLastBackfillDate(): string | null {
  try {
    return localStorage.getItem(LAST_BACKFILL_DATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLastBackfillDate(dateInput: string): void {
  try {
    localStorage.setItem(LAST_BACKFILL_DATE_STORAGE_KEY, dateInput);
  } catch {
    // Storage can fail (private browsing, quota) -- losing the saved date
    // just means the next visit falls back to the one-year-ago default,
    // not a functional break.
  }
}

let synced: Promise<void> | null = null;

/** Incremental Strava sync on app open, once a first backfill (a
 * deliberate click on the Runs tab) has set the saved date: the plan reads
 * new runs without a trip to Runs. Once per page load; resolves when the
 * sync has finished (or failed), for modelRefresh.ts to follow. */
export function syncOnOpen(): Promise<void> {
  const from = loadLastBackfillDate();
  if (!from) return Promise.resolve();
  synced ??= runBackfillBatch(from, () => saveLastBackfillDate(new Date().toISOString().slice(0, 10)));
  return synced;
}
