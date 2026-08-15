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
 * activity replaces its row). */
export async function saveCourse(name: string, points: GpxPoint[], id?: string): Promise<StoredCourse> {
  const { distanceM, elevationGain } = rawCourseStats(points);
  const course: StoredCourse = {
    id: id ?? crypto.randomUUID(),
    name,
    points,
    addedAt: Date.now(),
    distanceM,
    elevationGainM: elevationGain,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(course);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return course;
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
