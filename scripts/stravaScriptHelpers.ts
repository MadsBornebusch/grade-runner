// Shared plumbing for ad hoc scripts that exercise the real Strava API
// through a locally-running `vercel dev` server, authenticated via a
// copied browser session cookie -- see testRealStravaFit.ts's header
// comment for the one-time setup (log in via browser, copy the gr_session
// cookie into a gitignored .strava-session.local file). Not part of the
// automated test suite; both testRealStravaFit.ts and backtestFinishTime.ts
// import from here rather than each keeping their own copy.

import { readFileSync } from "node:fs";
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

export async function fetchActivityPoints(
  baseUrl: string,
  cookie: string,
  stravaId: number,
): Promise<{ name: string; points: GpxPoint[] }> {
  const body = (await fetchJson(baseUrl, `/api/strava/activity?id=${stravaId}`, cookie)) as {
    name: string;
    points: WireGpxPoint[];
  };
  const points: GpxPoint[] = body.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  return { name: body.name, points };
}

export interface BackfillOptions {
  maxPages?: number;
  perPage?: number;
}

const DEFAULT_MAX_BACKFILL_PAGES = 20;
const DEFAULT_BACKFILL_PER_PAGE = 100;

/** Mirrors RunLibraryPanel.tsx's runBackfill loop, minus the IndexedDB
 * write -- runs are kept in memory only, for these one-off scripts. */
export async function backfill(
  baseUrl: string,
  cookie: string,
  sinceDate: Date,
  opts: BackfillOptions = {},
): Promise<StoredRun[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_BACKFILL_PAGES;
  const perPage = opts.perPage ?? DEFAULT_BACKFILL_PER_PAGE;
  const runs: StoredRun[] = [];
  let page = 1;
  for (;;) {
    const body = (await fetchJson(
      baseUrl,
      `/api/strava/activities?page=${page}&per_page=${perPage}`,
      cookie,
    )) as BackfillPage;
    for (const r of filterRunsSinceDate(body.runs, sinceDate)) {
      const input = toStoredRunSummaryInput(r);
      runs.push({
        id: `strava:${input.stravaId}`,
        name: input.name,
        addedAt: Date.now(),
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
  return runs;
}
