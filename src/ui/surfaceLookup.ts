// Client-side helper for fetching surface classification via api/surface.ts
// (a proxy to Valhalla's public map-matching service). Deliberately fails
// soft everywhere -- a Valhalla outage, rate limit, or network hiccup
// should degrade to "no surface data for this course" (matching
// CourseSegment.surfaceUnpaved's own "undefined means unknown" contract),
// never block or fail the rest of planning/fitting.

import type { GpxPoint } from "../gpx/pipeline";
import type { ValhallaSurfaceEdge } from "../model/surfaceExposure";

/** Matches api/surface.ts's own MAX_SHAPE_POINTS, with headroom -- keeping
 * comfortably under it here avoids a request that's rejected outright for
 * a long ultra's raw point count. */
const MAX_SHAPE_POINTS = 800;

function downsample(points: GpxPoint[], maxPoints: number): GpxPoint[] {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: GpxPoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  return out;
}

/**
 * Fetches per-edge surface classification for a route's raw GPS points.
 * Returns null on any failure (network error, non-2xx response, Valhalla
 * down) -- callers should treat null exactly like "never fetched", not as
 * an error to surface to the user; this is a best-effort enhancement, not
 * a required step.
 */
export async function fetchSurfaceEdges(points: GpxPoint[]): Promise<ValhallaSurfaceEdge[] | null> {
  if (points.length < 2) return null;
  const shape = downsample(points, MAX_SHAPE_POINTS).map((p) => ({ lat: p.lat, lon: p.lon }));
  try {
    const res = await fetch("/api/surface", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shape }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { edges?: ValhallaSurfaceEdge[] };
    return body.edges ?? null;
  } catch {
    return null;
  }
}
