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

let synced = false;

/** Incremental Strava sync on app open, once a first backfill (a
 * deliberate click in Settings) has set the saved date: the plan reads new
 * runs without a trip to Settings. Once per page load. Choosing which new
 * runs to download in full stays with Settings, which marks them when it
 * next opens. */
export function syncOnOpen(): void {
  const from = loadLastBackfillDate();
  if (synced || !from) return;
  synced = true;
  void runBackfillBatch(from, () => saveLastBackfillDate(new Date().toISOString().slice(0, 10)));
}
