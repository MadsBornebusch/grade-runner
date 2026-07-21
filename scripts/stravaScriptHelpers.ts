// Shared plumbing for ad hoc scripts that exercise the real Strava API
// through a locally-running `vercel dev` server, authenticated via a
// copied browser session cookie -- see testRealStravaFit.ts's header
// comment for the one-time setup (log in via browser, copy the gr_session
// cookie into a gitignored .strava-session.local file). Not part of the
// automated test suite; both testRealStravaFit.ts and backtestFinishTime.ts
// import from here rather than each keeping their own copy.
//
// On-disk cache (.strava-cache/, gitignored): Strava's API rate limit is
// easy to exhaust across a session of repeated ad hoc diagnostics -- each
// script re-fetching the same historical activities is pure waste, since
// a past activity's recorded points never change. fetchActivityPoints
// caches per-activity points forever (no TTL, no invalidation -- there's
// nothing to invalidate). backfill's run-summary list *can* grow over
// time (new runs happen), so it always attempts a live fetch first and
// merges the result into the cache; only on a live-fetch failure (e.g. a
// 429) does it fall back to serving whatever's cached, so a rate limit
// degrades a script to "possibly stale" instead of "can't run at all".

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GpxPoint } from "../src/gpx/pipeline.ts";
import {
  filterRunsSinceDate,
  shouldFetchNextBackfillPage,
  toStoredRunSummaryInput,
  type BackfillPage,
} from "../src/model/stravaBackfill.ts";
import type { StoredRun } from "../src/storage/runLibrary.ts";

export function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const ACTIVITIES_CACHE_PATH = `${CACHE_DIR}activities.json`;

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function activityPointsCachePath(stravaId: number): string {
  return `${CACHE_DIR}activity-${stravaId}.json`;
}

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function readActivitiesCache(): Map<string, StoredRun> {
  try {
    const rows = JSON.parse(readFileSync(ACTIVITIES_CACHE_PATH, "utf8")) as StoredRun[];
    return new Map(rows.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

function writeActivitiesCache(byId: Map<string, StoredRun>): void {
  ensureCacheDir();
  writeFileSync(ACTIVITIES_CACHE_PATH, JSON.stringify([...byId.values()]));
}

export function loadCookie(sessionFilePath: string, baseUrl: string): string {
  try {
    return readFileSync(sessionFilePath, "utf8").trim();
  } catch {
    throw new Error(
      `Missing ${sessionFilePath}. Log in via the browser at ${baseUrl}, copy the gr_session cookie value from ` +
        `DevTools (Application > Cookies), and save just that value (no "gr_session=" prefix) into that file.`,
    );
  }
}

export async function fetchJson(baseUrl: string, path: string, cookie: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: `gr_session=${cookie}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

/** Mirrors stravaClient.ts's fetchStravaActivity -- `time` comes back as an
 * ISO string over JSON, parsed back to a Date here. */
interface WireGpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: string | null;
  hr: number | null;
  power: number | null;
}

/**
 * Fetches one activity's full points, transparently cached on disk forever
 * -- a past activity's recorded points never change, so once fetched there's
 * no reason to ever hit Strava for the same id again. Pass
 * { forceRefetch: true } to bypass the cache (e.g. if a cached entry is
 * ever suspected corrupt); the fresh result overwrites the cache either way.
 */
export async function fetchActivityPoints(
  baseUrl: string,
  cookie: string,
  stravaId: number,
  opts: { forceRefetch?: boolean } = {},
): Promise<{ name: string; points: GpxPoint[] }> {
  const cachePath = activityPointsCachePath(stravaId);
  if (!opts.forceRefetch && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedActivityPoints;
    return { name: cached.name, points: cached.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
  }

  const body = (await fetchJson(baseUrl, `/api/strava/activity?id=${stravaId}`, cookie)) as {
    name: string;
    points: WireGpxPoint[];
  };
  const points: GpxPoint[] = body.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));

  ensureCacheDir();
  const toCache: CachedActivityPoints = { name: body.name, points: body.points };
  writeFileSync(cachePath, JSON.stringify(toCache));

  return { name: body.name, points };
}

export interface BackfillOptions {
  maxPages?: number;
  perPage?: number;
  /** Skip the live fetch entirely and serve straight from the on-disk cache
   * -- useful once you already know Strava is rate-limited, to avoid
   * wasting a request finding that out again. */
  offline?: boolean;
}

const DEFAULT_MAX_BACKFILL_PAGES = 20;
const DEFAULT_BACKFILL_PER_PAGE = 100;

/**
 * Mirrors RunLibraryPanel.tsx's runBackfill loop, minus the IndexedDB write.
 * Always attempts a live fetch first (the run list can grow over time, so
 * unlike activity points it's not simply cacheable forever) and merges
 * whatever it gets into the on-disk activities cache. If the live fetch
 * fails partway (e.g. a 429) it logs a warning and falls back to returning
 * the merged cache -- so a rate limit degrades this to "possibly missing
 * your most recent runs" instead of "the script can't run at all".
 */
export async function backfill(
  baseUrl: string,
  cookie: string,
  sinceDate: Date,
  opts: BackfillOptions = {},
): Promise<StoredRun[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_BACKFILL_PAGES;
  const perPage = opts.perPage ?? DEFAULT_BACKFILL_PER_PAGE;
  const cached = readActivitiesCache();

  if (!opts.offline) {
    let page = 1;
    try {
      for (;;) {
        const body = (await fetchJson(
          baseUrl,
          `/api/strava/activities?page=${page}&per_page=${perPage}`,
          cookie,
        )) as BackfillPage;
        for (const r of filterRunsSinceDate(body.runs, sinceDate)) {
          const input = toStoredRunSummaryInput(r);
          const id = `strava:${input.stravaId}`;
          cached.set(id, {
            id,
            name: input.name,
            addedAt: cached.get(id)?.addedAt ?? Date.now(),
            points: null,
            stravaId: input.stravaId,
            date: input.date,
            distanceKm: input.distanceKm,
            durationS: input.durationS,
            elevationGainM: input.elevationGainM,
            avgHeartRate: input.avgHeartRate,
            avgWatts: input.avgWatts,
          });
        }
        if (!shouldFetchNextBackfillPage(body, page, sinceDate, maxPages)) break;
        page++;
      }
      writeActivitiesCache(cached);
    } catch (err) {
      console.log(
        `  WARNING: live Strava backfill failed on page ${page} (${err instanceof Error ? err.message : err}) -- ` +
          `falling back to the on-disk cache (.strava-cache/activities.json), which may be missing recent runs.`,
      );
    }
  }

  return [...cached.values()].filter((r) => r.date && new Date(r.date) >= sinceDate);
}
