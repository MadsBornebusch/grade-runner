// Persists a small library of past runs in IndexedDB, keyed per run.
//
// A run's points can be null -- "summary only", from a cheap Strava
// activity-list backfill that never called the per-activity detail/streams
// endpoints. Points are fetched lazily (setStoredRunPoints) only when a run
// is actually selected for a fit. Strava-sourced runs use a stable
// "strava:<id>" key (not a random UUID) so re-importing or re-backfilling
// the same activity upserts one row instead of duplicating it.

import type { GpxPoint } from "../gpx/pipeline";

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
