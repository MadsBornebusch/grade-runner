// Runs the Strava backfill (pull lightweight summaries page by page since a
// date) as a module-level process, same pattern and same reason as
// autoFetchRuns.ts: Settings intentionally unmounts RunLibraryPanel when
// closed, so anything driven by local component state (the original design
// here) gets silently abandoned mid-fetch -- no visible progress, and a
// second click on reopen starts a genuinely CONCURRENT second backfill
// instead of resuming or no-opping. Moving the loop here means it keeps
// running (and stays visible) across any number of mounts/unmounts.

import { filterRunsSinceDate, shouldFetchNextBackfillPage, toStoredRunSummaryInput, type BackfillPage } from "../model/stravaBackfill";
import { upsertStoredRunSummary } from "../storage/runLibrary";

const BACKFILL_MAX_PAGES = 50;
const BACKFILL_PER_PAGE = 100;
const BACKFILL_PAGE_DELAY_MS = 300;

export interface BackfillStatus {
  running: boolean;
  progress: string | null;
  error: string | null;
}

let status: BackfillStatus = { running: false, progress: null, error: null };
const listeners = new Set<() => void>();

function setStatus(next: BackfillStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeToBackfill(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBackfillStatus(): BackfillStatus {
  return status;
}

/**
 * Idempotent against concurrent calls, same discipline as
 * autoFetchRuns.ts's runAutoFetchBatch -- a second call while one is
 * already running is a silent no-op, so it's safe to call from every
 * mount/remount (including reopening Settings mid-backfill) without risking
 * a duplicate, competing fetch loop. `onDone` fires once at the end with
 * the imported count, ONLY on success -- the caller uses it to advance the
 * saved "since" date and mark new fetch candidates; the live progress text
 * doesn't need it (reads this module's own status via useSyncExternalStore).
 */
export async function runBackfillBatch(fromDateInput: string, onDone: (importedCount: number) => void): Promise<void> {
  if (status.running) return;

  const targetStartDate = new Date(fromDateInput);
  let page = 1;
  let imported = 0;
  setStatus({ running: true, progress: `Fetching page ${page}…`, error: null });

  try {
    for (;;) {
      setStatus({ running: true, progress: `Fetching page ${page}…`, error: null });
      const res = await fetch(`/api/strava/activities?page=${page}&per_page=${BACKFILL_PER_PAGE}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Backfill failed.");
      const pageResult = body as BackfillPage;

      for (const run of filterRunsSinceDate(pageResult.runs, targetStartDate)) {
        await upsertStoredRunSummary(toStoredRunSummaryInput(run));
        imported++;
      }

      if (!shouldFetchNextBackfillPage(pageResult, page, targetStartDate, BACKFILL_MAX_PAGES)) break;
      page++;
      await new Promise((r) => setTimeout(r, BACKFILL_PAGE_DELAY_MS));
    }
    setStatus({ running: false, progress: `Imported ${imported} run${imported === 1 ? "" : "s"}.`, error: null });
    onDone(imported);
  } catch (err) {
    setStatus({ running: false, progress: null, error: err instanceof Error ? err.message : "Backfill failed." });
  }
}
