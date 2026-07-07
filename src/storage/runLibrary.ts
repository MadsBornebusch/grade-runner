// Persists a small library of past runs (raw parsed GPX points) in
// IndexedDB, keyed per run. Stores points rather than a derived summary --
// re-running the pipeline/analysis on demand means a stored run always
// reflects the current model, with nothing to migrate when the model
// changes.

import type { GpxPoint } from "../gpx/pipeline";

export interface StoredRun {
  id: string;
  name: string;
  addedAt: number;
  points: GpxPoint[];
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

export async function addStoredRun(name: string, points: GpxPoint[]): Promise<StoredRun> {
  const run: StoredRun = { id: crypto.randomUUID(), name, addedAt: Date.now(), points };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(run);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return run;
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
