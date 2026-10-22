// The plan's run history, built from the stored runs in the browser. Each
// run with points goes through the course pipeline (about 10 ms each), so
// results are cached in localStorage per run and only new or changed runs
// are processed, a few at a time between frames.
import type { StoredRun } from "../storage/runLibrary";
import { historyRunFromStored, type DatedHistoryRun } from "./historyFromRuns";

/** Bump when historyRunFromStored's output changes, to rebuild the cache. */
const CACHE_VERSION = 1;
const CACHE_KEY = "grade-runner.historyCache.v1";
const CHUNK = 8;

type Cache = { version: number; timeZone: string; byKey: Record<string, DatedHistoryRun | null> };

const keyOf = (run: StoredRun) =>
  `${run.id}:${run.points ? `p${run.points.length}` : "s"}:${run.durationS ?? ""}:${run.distanceKm ?? ""}`;

function readCache(timeZone: string): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const cache = raw ? (JSON.parse(raw) as Cache) : null;
    if (cache && cache.version === CACHE_VERSION && cache.timeZone === timeZone) return cache;
  } catch {
    // Rebuilt below.
  }
  return { version: CACHE_VERSION, timeZone, byKey: {} };
}

function writeCache(cache: Cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Too big or blocked: rebuilt next time.
  }
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The history for every stored run, sorted by day. `onProgress` gets the
 * count of runs processed so far when some weren't cached. */
export async function buildHistory(runs: StoredRun[], timeZone: string, onProgress?: (done: number, total: number) => void): Promise<DatedHistoryRun[]> {
  const cache = readCache(timeZone);
  const keep: Cache["byKey"] = {};
  const todo: StoredRun[] = [];
  for (const run of runs) {
    const key = keyOf(run);
    if (key in cache.byKey) keep[key] = cache.byKey[key];
    else todo.push(run);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    for (const run of todo.slice(i, i + CHUNK)) keep[keyOf(run)] = historyRunFromStored(run, timeZone);
    onProgress?.(Math.min(todo.length, i + CHUNK), todo.length);
    await nextFrame();
  }
  writeCache({ version: CACHE_VERSION, timeZone, byKey: keep });
  return Object.values(keep)
    .filter((r): r is DatedHistoryRun => r !== null)
    .sort((a, b) => a.day - b.day);
}
