// Persists a small library of previously-used course GPX files in
// IndexedDB, so they can be re-selected on the Course page instead of
// re-uploading/re-importing. Separate database from runLibrary.ts's
// recorded-run library -- courses (planning routes, re-used across many
// planning sessions) and runs (recorded efforts, fed into the athlete fit)
// have different lifecycles and no reason to share a version-migration
// path.

import type { GpxPoint } from "../gpx/pipeline";
import { rawCourseStats } from "../gpx/pipeline";

export interface StoredCourse {
  id: string;
  name: string;
  points: GpxPoint[];
  addedAt: number;
  distanceM: number;
  elevationGainM: number;
  /** Aid-station points saved on RouteMap.tsx for this specific course --
   * persisted so re-selecting the course later (including after a page
   * refresh) brings them back instead of starting from an empty map every
   * time. Undefined (not []) on any course saved before this field existed,
   * or one that's never had a point saved -- App.tsx treats both the same
   * (?? []). */
  savedPointsKm?: number[];
  /** The athlete's own chosen target finish time for this course, seconds
   * -- persisted the same way as savedPointsKm, distinct from the app's
   * OWN predicted time (which isn't stored; it's recomputed from the
   * current athlete profile every load). null/undefined means no override
   * is set, same "falls back to the predicted number" behavior as leaving
   * the Target finish time field empty. */
  targetTimeS?: number | null;
}

const DB_NAME = "grade-runner-courses";
const DB_VERSION = 1;
const STORE_NAME = "courses";

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

/** Saves a course under a fresh id -- a repeat upload of the same file
 * (same name) adds another row rather than upserting, matching
 * runLibrary.ts's own addStoredRun behavior for plain (non-Strava) GPX
 * uploads. Pass a stravaId-backed stable id via the id param to upsert
 * instead (Strava course imports use this so re-importing the same
 * activity replaces its row) -- an upsert carries over any existing row's
 * savedPointsKm/targetTimeS rather than wiping them, since re-importing
 * the same activity (e.g. to pick up a GPS/elevation reprocessing fix)
 * isn't a signal the athlete wants their aid-station planning discarded. */
export async function saveCourse(name: string, points: GpxPoint[], id?: string): Promise<StoredCourse> {
  const { distanceM, elevationGain } = rawCourseStats(points);
  const db = await openDb();
  const existing = id ? await getStoredCourse(db, id) : null;
  const course: StoredCourse = {
    id: id ?? crypto.randomUUID(),
    name,
    points,
    addedAt: Date.now(),
    distanceM,
    elevationGainM: elevationGain,
    savedPointsKm: existing?.savedPointsKm,
    targetTimeS: existing?.targetTimeS,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(course);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return course;
}

function getStoredCourse(db: IDBDatabase, id: string): Promise<StoredCourse | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result as StoredCourse | undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Partial update for the two fields RouteMap/App.tsx (Results page) can
 * change after a course is already saved -- saved aid-station points and
 * an athlete-chosen target finish time. Reads the existing row, merges,
 * and writes it back rather than a bare `put` of just these fields, since
 * IndexedDB `put` fully replaces a record (a partial object would silently
 * drop name/points/etc.). A no-op (not an error) if the course has since
 * been deleted -- same "let it finish, don't corrupt in-flight state"
 * discipline runFitBatch.ts uses elsewhere, just for the simpler case of
 * "the thing I was about to update is already gone."
 */
export async function updateStoredCourseCheckpoints(
  id: string,
  updates: { savedPointsKm?: number[]; targetTimeS?: number | null },
): Promise<void> {
  const db = await openDb();
  const existing = await getStoredCourse(db, id);
  if (!existing) return;
  const updated: StoredCourse = { ...existing, ...updates };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(updated);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listStoredCourses(): Promise<StoredCourse[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as StoredCourse[]).sort((a, b) => b.addedAt - a.addedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStoredCourse(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
