// Runs the "fetch full data for every run marked wantsFullData" batch as a
// plain module-level process, deliberately NOT tied to any React
// component's mount lifecycle. Settings (SettingsModal.tsx) intentionally
// unmounts RunLibraryPanel when closed -- that's the right call for
// genuinely ephemeral UI state (in-flight fit, error text), but this batch
// is real background work: closing Settings mid-fetch used to cancel the
// loop outright (its effect's cleanup set a `cancelled` flag), so every
// reopen re-showed "0 of N remaining" and looked like it kept restarting
// from scratch even though (slow) progress was technically still real.
// Moving the loop here means it keeps running across any number of
// mounts/unmounts of the panel that triggered it -- only page reloads
// stop it, which is a real, unavoidable stopping point either way.

import type { GpxPoint } from "../gpx/pipeline";
import { setStoredRunPoints, type StoredRun } from "../storage/runLibrary";
import { fetchStravaActivity, StravaFetchError } from "./stravaClient";

/** Paces fetches so a large batch doesn't hammer Strava's API all at once
 * and trip its rate limit -- same spirit as backfill's own page delay. */
const AUTO_FETCH_DELAY_MS = 250;

/**
 * How long to stay quiet after actually hitting Strava's rate limit (a real
 * 429, not just any failure) before letting a new batch start. Strava's own
 * limit window is 15 minutes -- without this, every RunLibraryPanel mount
 * (i.e. every time Settings is opened) re-fired the whole pending batch
 * immediately, which just re-hit the same still-active rate limit and
 * burned through whatever headroom had recovered, so it never actually
 * cleared. Deliberately longer than Strava's own window so the count has
 * genuinely reset by the time a retry fires, not just "shortly".
 */
const RATE_LIMIT_COOLDOWN_MS = 16 * 60 * 1000;

let rateLimitedUntil = 0;

export interface AutoFetchStatus {
  running: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
}

let status: AutoFetchStatus = { running: false, progress: null, error: null };
const listeners = new Set<() => void>();

function setStatus(next: AutoFetchStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeToAutoFetch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAutoFetchStatus(): AutoFetchStatus {
  return status;
}

/** Fetches and persists full points for a summary-only row; a no-op if
 * they're already present. Module-level (not a component method) so the
 * batch loop below can keep calling it after whatever component triggered
 * the batch has unmounted. */
export async function ensurePointsForRun(run: StoredRun): Promise<GpxPoint[]> {
  if (run.points !== null) return run.points;
  if (run.stravaId === undefined) return [];
  const { points } = await fetchStravaActivity(run.stravaId);
  await setStoredRunPoints(run.id, points);
  return points;
}

/**
 * Fetches full data for every run in `pending`, in place, updating the
 * shared status as it goes. Idempotent against concurrent calls -- if a
 * batch is already running, a second call is a silent no-op rather than
 * starting a competing loop (the caller doesn't need to track this itself;
 * every mount of the panel can safely call this any time its own pending
 * list is non-empty). `onDone` fires once, only at the very end -- the
 * live "N of M" progress display doesn't need it at all (it reads this
 * module's own status via useSyncExternalStore), so this is purely for a
 * currently-mounted caller to re-pull the run list once new data exists.
 * Deliberately NOT called after every single item: with a 60-run batch
 * that's 60 component re-renders (and re-derivations of every useMemo
 * downstream of the run list) for a value nothing but this one signal
 * actually needs live.
 */
export async function runAutoFetchBatch(pending: StoredRun[], onDone: () => void): Promise<void> {
  if (status.running) return;
  if (pending.length === 0) return;
  // Still cooling down from a real 429 last time -- every mount of
  // RunLibraryPanel calls this unconditionally, so without this guard
  // reopening Settings during the cooldown would immediately re-fire the
  // batch, re-hit the still-active limit, and reset the clock forever.
  if (Date.now() < rateLimitedUntil) return;

  const total = pending.length;
  let failures = 0;
  let rateLimited = false;
  setStatus({ running: true, progress: { done: 0, total }, error: null });

  for (let i = 0; i < total; i++) {
    setStatus({ running: true, progress: { done: i, total }, error: null });
    try {
      await ensurePointsForRun(pending[i]);
    } catch (err) {
      failures++;
      if (err instanceof StravaFetchError && err.status === 429) {
        // No point burning through the rest of the batch -- every remaining
        // request will hit the same limit.
        rateLimited = true;
        break;
      }
    }
    if (i < total - 1) await new Promise((r) => setTimeout(r, AUTO_FETCH_DELAY_MS));
  }

  if (rateLimited) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;

  setStatus({
    running: false,
    progress: null,
    error: rateLimited
      ? `Fetched ${total - failures} of ${total} recommended runs -- Strava's rate limit kicked in. Paused; retries automatically in about 15 minutes.`
      : failures > 0
        ? `Fetched ${total - failures} of ${total} recommended runs -- ${failures} failed. Try again shortly.`
        : null,
  });
  onDone();
}
