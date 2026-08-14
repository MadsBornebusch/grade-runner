// Persists a small library of past runs in IndexedDB, keyed per run.
//
// A run's points can be null -- "summary only", from a cheap Strava
// activity-list backfill that never called the per-activity detail/streams
// endpoints. Points are fetched lazily (setStoredRunPoints) only when a run
// is actually selected for a fit. Strava-sourced runs use a stable
// "strava:<id>" key (not a random UUID) so re-importing or re-backfilling
// the same activity upserts one row instead of duplicating it.

import type { GpxPoint } from "../gpx/pipeline";
import type { ValhallaSurfaceEdge } from "../model/surfaceExposure";

export interface StoredRun {
  id: string;
  name: string;
  addedAt: number;
  /** null = summary only, not yet fetched from Strava. */
  points: GpxPoint[] | null;
  stravaId?: number;
  /** ISO date, from Strava's start_date. Only present for summary-derived rows. */
  date?: string;
  distanceKm?: number;
  /** Moving time, seconds. */
  durationS?: number;
  elevationGainM?: number;
  avgHeartRate?: number | null;
  avgWatts?: number | null;
  /**
   * Cached Valhalla surface-classification response, fetched lazily (like
   * points) once this run is selected for a fit -- avoids re-hitting
   * Valhalla on every fit. Undefined means either never attempted, or a
   * past attempt failed (Valhalla down, rate-limited) -- a failure is
   * deliberately NOT cached as a permanent "no data" result, so the next
   * fit naturally retries instead of being stuck without surface data
   * forever over what might have been a transient outage.
   */
  surfaceEdges?: ValhallaSurfaceEdge[];
  /**
   * Set once, right after a backfill identifies this summary-only run as
   * worth fetching full data for (a suggestRunsForFit candidate) -- the
   * auto-fetch effect in RunLibraryPanel.tsx then just filters on this flag
   * plus points===null, instead of re-deriving "what's worth fetching" from
   * a live re-ranking on every render. Re-ranking reactively was the actual
   * cause of fetches appearing to "fail and restart" -- suggestRunsForFit's
   * candidate set can shift slightly as runs gain full data, so recomputing
   * it mid-batch (any time `runs` got a new array reference, which
   * listStoredRuns() gives on every call even with unchanged content)
   * could hand the fetch effect a different-enough list to look like it
   * started over. Persisting the decision once makes "which runs do we
   * still owe full data" a stable, inspectable fact instead of a derived
   * value that can flicker.
   */
  wantsFullData?: boolean;
  /**
   * Set once, after this run's full data has been downloaded and checked
   * against the VO2max estimate's own duration window (see
   * vo2MaxEstimate.ts's isEstimableEffort) -- true if at least one of its
   * transit-gap-split legs qualifies, false if none do. Safe to cache
   * indefinitely: which duration bucket a leg's own moving time falls
   * into depends only on GPS-detected pauses (never on any user-editable
   * setting), not on formInputs, so this verdict can't go stale the way a
   * computed *value* (which does depend on bodyMassKg/ceilingParams/etc.)
   * would. undefined = not yet checked. Lets RunLibraryPanel.tsx skip
   * re-running the full pipeline (transit-gap split + course build) on
   * every render for a run already known to have no usable leg, instead
   * of silently re-testing the same negative result over and over.
   */
  vo2MaxEstimable?: boolean;
  /**
   * User-confirmed: was this genuinely a race run to real effort, as
   * opposed to a training run, structured workout, or an enforced-rest
   * format (backyard ultra loops) that only LOOKS like a long sustained
   * effort? Deliberately NOT auto-detected from the activity name alone --
   * a real check this session found a name heuristic (non-generic title)
   * misclassified a club interval session as a race, and would have
   * conflated a backyard-ultra loop format with a continuous effort too.
   * The pacing-margin curve fit (pacingMarginFit.ts) is built from a
   * handful of races where getting this one label right matters far more
   * than it does for the "pool everything, duration alone gates it" fits
   * elsewhere in this app -- undefined = not yet reviewed (candidate,
   * shown for tagging but not yet included either way).
   */
  raceTag?: "race" | "notRace";
}

export interface StravaRunSummaryInput {
  stravaId: number;
  name: string;
  date: string;
  distanceKm: number;
  durationS: number;
  elevationGainM: number;
  avgHeartRate: number | null;
  avgWatts: number | null;
}

const DB_NAME = "grade-runner";
const DB_VERSION = 1;
const STORE_NAME = "runs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Manual GPX upload, or a single Strava activity import -- always supplies
 * full points immediately. Passing stravaId makes the id stable, so
 * re-importing the same activity (or a later bulk backfill of it) upserts
 * this row instead of creating a duplicate. */
export async function addStoredRun(name: string, points: GpxPoint[], stravaId?: number): Promise<StoredRun> {
  const run: StoredRun = {
    id: stravaId !== undefined ? `strava:${stravaId}` : crypto.randomUUID(),
    name,
    addedAt: Date.now(),
    points,
    ...(stravaId !== undefined ? { stravaId } : {}),
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(run);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return run;
}

/** Backfill path: stores a lightweight Strava summary without fetching full
 * points. Preserves an existing row's points/addedAt if one is already
 * present under the same stable id (e.g. re-backfilling, or a prior
 * single-import already fetched this activity's full data). */
export async function upsertStoredRunSummary(summary: StravaRunSummaryInput): Promise<void> {
  const id = `strava:${summary.stravaId}`;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredRun | undefined;
      const run: StoredRun = {
        id,
        name: summary.name,
        addedAt: existing?.addedAt ?? Date.now(),
        points: existing?.points ?? null,
        stravaId: summary.stravaId,
        date: summary.date,
        distanceKm: summary.distanceKm,
        durationS: summary.durationS,
        elevationGainM: summary.elevationGainM,
        avgHeartRate: summary.avgHeartRate,
        avgWatts: summary.avgWatts,
      };
      store.put(run);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Upgrades a summary-only row in place once its full points have been
 * lazily fetched, so they're not re-fetched next time. */
export async function setStoredRunPoints(id: string, points: GpxPoint[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredRun | undefined;
      if (existing) store.put({ ...existing, points });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Caches a successful surface lookup in place -- mirrors setStoredRunPoints.
 * Callers should simply not call this on a failed/empty lookup, rather than
 * caching a "no data" sentinel (see StoredRun.surfaceEdges's own doc). */
export async function setStoredRunSurfaceEdges(id: string, surfaceEdges: ValhallaSurfaceEdge[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as StoredRun | undefined;
      if (existing) store.put({ ...existing, surfaceEdges });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Marks a set of already-stored summary rows as wanted for a full-data
 * fetch -- one transaction, not one per id. Silently skips any id that
 * isn't actually present (e.g. deleted as a duplicate between being
 * suggested and marked) rather than failing the whole batch over it. */
export async function markRunsWantedForFetch(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredRun | undefined;
        if (existing) store.put({ ...existing, wantsFullData: true });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Persists the VO2max-estimability verdict (see StoredRun.vo2MaxEstimable's
 * own doc) for a batch of runs in one transaction. Each entry's own
 * `estimable` value is written independently -- unlike markRunsWantedForFetch,
 * this isn't a uniform "set true for all of these" call, since different
 * runs resolve to true or false. */
export async function setVo2MaxEstimability(results: { id: string; estimable: boolean }[]): Promise<void> {
  if (results.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const { id, estimable } of results) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredRun | undefined;
        if (existing) store.put({ ...existing, vo2MaxEstimable: estimable });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Same one-transaction batch pattern as setVo2MaxEstimability -- persists a
 * user's race/not-race calls from the tagging list in one write. */
export async function setStoredRunRaceTags(tags: { id: string; raceTag: "race" | "notRace" }[]): Promise<void> {
  if (tags.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const { id, raceTag } of tags) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredRun | undefined;
        if (existing) store.put({ ...existing, raceTag });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listStoredRuns(): Promise<StoredRun[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as StoredRun[]).sort((a, b) => b.addedAt - a.addedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStoredRun(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipes the entire run library. Irreversible -- callers should confirm with
 * the user before invoking this. */
export async function clearStoredRuns(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
