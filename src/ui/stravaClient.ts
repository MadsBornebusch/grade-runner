import type { GpxPoint } from "../gpx/pipeline";

/** Same fields as GpxPoint, but as it comes over the wire -- `time` is an
 * ISO string (JSON has no Date type), parsed back to a Date before this
 * reaches any caller. */
interface WireGpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: string | null;
  hr: number | null;
  power: number | null;
}

/** Fetches one activity's full GPS points from Strava -- used both for a
 * one-off import (StravaImport) and to lazily upgrade a summary-only
 * backfilled run (RunLibraryPanel) the first time it's actually selected
 * for a fit. */
export async function fetchStravaActivity(stravaId: number): Promise<{ name: string; points: GpxPoint[] }> {
  const res = await fetch(`/api/strava/activity?id=${stravaId}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to fetch this activity from Strava.");
  const points: GpxPoint[] = (body.points as WireGpxPoint[]).map((p) => ({
    ...p,
    time: p.time ? new Date(p.time) : null,
  }));
  return { name: body.name, points };
}
