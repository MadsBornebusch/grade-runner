// Keeps the athlete model up to date without a trip to the Runs tab
// (user request, 2026-10-22): after the sync on app open, download full
// data for the newly chosen runs, then refit if the set of runs the fit
// would use has changed since the last fit. Module-level, like
// runFitBatch.ts, so it keeps going across tab switches.

import { dedupeStoredRuns } from "../model/dedupeRuns";
import { selectFetchCandidateIds } from "../model/suggestRuns";
import { listStoredRuns, markRunsWantedForFetch, type StoredRun } from "../storage/runLibrary";
import { getAutoFetchStatus, isDueForFetch, runAutoFetchBatch, subscribeToAutoFetch } from "./autoFetchRuns";
import { resolveCeilingParams, type FormInputs } from "./formInputs";
import { getRunFitStatus, runFitBatch, type RunFitCallbacks } from "./runFitBatch";

/** suggestRunsForFit's own default (10 per bucket) is deliberately small --
 * it exists to keep a MANUAL review list short (see that file's own doc:
 * "meant to replace manually scanning hundreds of rows, not to invite
 * fetching all of them"). That rationale doesn't apply once fetching is
 * fully automatic (no one is scanning rows) -- a 10-per-bucket cap
 * silently starved a real backfill of 280 summaries down to just 10
 * downloaded runs, nowhere near enough moving time to fit anything. This
 * is the PER-BUCKET pool size fed into suggestRunsForFit -- generous on
 * purpose, since AUTO_FETCH_TOTAL_CAP below is what actually bounds how
 * many get fetched; this just needs to be large enough that each bucket
 * has enough of its own pool to pick a good, diverse set from before that
 * final cap trims the combined list down. */
const AUTO_FETCH_CANDIDATE_COUNT = 60;
/** The REAL ceiling on how many runs get auto-fetched, across all
 * suggestion buckets combined -- suggestRunsForFit's own candidateCount
 * only bounds each bucket independently, so passing it
 * AUTO_FETCH_CANDIDATE_COUNT alone still let the deduped union balloon to
 * up to 3x that (a real 280-summary backfill produced 138 candidates, not
 * 60). This total is enforced by interleaving picks round-robin across the
 * buckets before truncating, so a big vo2max pool can't crowd out
 * the durability/duration-spread picks the tau fit actually needs.
 *
 * This is a cap on the LIFETIME marked set, not on one pass. Counting only
 * the current pass was the bug behind a library that grew to 122 marked
 * runs: every run that downloaded successfully dropped out of
 * suggestRunsForFit's `unfetched` pool, freeing its slot for the next-
 * ranked run, which the next Settings open then marked. The marked set
 * ratcheted up by roughly one new run per success and never converged, so
 * "needs to download N" refilled itself forever. */
const AUTO_FETCH_TOTAL_CAP = 60;

/** The fit's recency half-life when nobody has changed it on the Runs tab. */
export const DEFAULT_HALF_LIFE_DAYS = 75;

// Computes "which summary-only runs are worth fetching full data for"
// ONCE (via suggestRunsForFit + the same interleave-then-cap logic as
// before) and PERSISTS the decision (StoredRun.wantsFullData), rather
// than re-deriving it reactively on every render. Re-deriving reactively
// was the actual cause of fetches appearing to "fail and restart":
// listStoredRuns() (called by refresh()) returns a brand-new array every
// time even when nothing meaningful changed, so any refresh() firing
// anywhere (duplicate cleanup, a manual fit, etc.) gave the fetch
// effect's own dependency a new-but-similar list, aborting whatever
// iteration was in flight and restarting from a fresh (but nearly
// identical) batch. Marking is idempotent and cheap to call again with
// an unchanged candidate set (already-marked ids are just skipped).
export async function markNewFetchCandidates(): Promise<void> {
  const { kept } = dedupeStoredRuns(await listStoredRuns());
  const candidateIds = selectFetchCandidateIds(kept, AUTO_FETCH_TOTAL_CAP, AUTO_FETCH_CANDIDATE_COUNT);
  if (candidateIds.length > 0) await markRunsWantedForFetch(candidateIds);
}

/** What a fit depends on from the library: the runs with full data and
 * their race tags. Re-listing the same runs gives the same key. */
export function fitInputsKey(runs: Pick<StoredRun, "id" | "points" | "raceTag">[]): string {
  return runs
    .filter((r) => r.points !== null)
    .map((r) => `${r.id}:${r.raceTag ?? ""}`)
    .sort()
    .join(",");
}

const FIT_KEY_STORAGE_KEY = "grade-runner:lastFitInputsKey";

function loadFitKey(): string | null {
  try {
    return localStorage.getItem(FIT_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

const FIT_AT_STORAGE_KEY = "grade-runner:lastFitAt";

/** When the model was last refitted (epoch ms), on this device. */
export function loadLastFitAt(): number | null {
  try {
    const at = Number(localStorage.getItem(FIT_AT_STORAGE_KEY));
    return at > 0 ? at : null;
  } catch {
    return null;
  }
}

function saveFitKey(key: string): void {
  try {
    localStorage.setItem(FIT_KEY_STORAGE_KEY, key);
    localStorage.setItem(FIT_AT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Worst case the next open refits once more.
  }
}

/** A fit from the Runs tab's button counts too, so the next open doesn't
 * redo it. */
export async function saveFitInputsKeyAfterManualFit(): Promise<void> {
  saveFitKey(fitInputsKey(dedupeStoredRuns(await listStoredRuns()).kept));
}

function autoFetchIdle(): Promise<void> {
  if (!getAutoFetchStatus().running) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeToAutoFetch(() => {
      if (getAutoFetchStatus().running) return;
      unsubscribe();
      resolve();
    });
  });
}

let refreshing = false;

/**
 * Mark, download, refit. Reads the settings through `getFormInputs` when
 * the fit starts, so it measures against the current model. The key is
 * saved only after a fit that finished without error: a fit cut short
 * (tab closed, error) runs again next time. Runs waiting out a rate limit
 * have no points yet, so they stay out of the key until a later open.
 */
export async function refreshModel(getFormInputs: () => FormInputs, callbacks: RunFitCallbacks): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await markNewFetchCandidates();
    const pending = dedupeStoredRuns(await listStoredRuns()).kept.filter((r) => r.wantsFullData && r.points === null && isDueForFetch(r));
    if (pending.length > 0) void runAutoFetchBatch(pending, () => {});
    await autoFetchIdle();
    const ready = dedupeStoredRuns(await listStoredRuns()).kept.filter((r) => r.points !== null);
    const key = fitInputsKey(ready);
    if (ready.length === 0 || key === loadFitKey() || getRunFitStatus().running) return;
    const formInputs = getFormInputs();
    const started = Date.now();
    await runFitBatch(ready, formInputs, resolveCeilingParams(formInputs), DEFAULT_HALF_LIFE_DAYS, callbacks);
    const { result, error } = getRunFitStatus();
    if (!error && result && result.completedAt >= started) saveFitKey(key);
  } finally {
    refreshing = false;
  }
}
