// Builds a synthetic flat, straight-line course of a given distance -- for
// "I just want to plan pacing for a flat Xkm race, no real route to upload"
// (the Add Course panel's "generic distance" option). Zero elevation and no
// timestamps (a route to plan against, not a recorded run), so it flows
// through the exact same pipeline as a real GPX file.

import type { GpxPoint } from "./pipeline";

// Must match pipeline.ts's own (unexported) EARTH_RADIUS_M -- kept in sync
// here rather than exported from there, since that file has no other
// reason to expose it.
const EARTH_RADIUS_M = 6371000;

// Raw point spacing before pipeline.ts's own resampling -- generous enough
// that even a marathon-length course is a few hundred points, not
// thousands, while staying well under any real GPX's typical density.
const RAW_POINT_SPACING_M = 200;

/** Builds `count` points running due north from the equator/prime
 * meridian, spaced so consecutive points are exactly `distanceKm/(count-1)`
 * apart per pipeline.ts's own haversine distance (exact inverse of that
 * formula for two points sharing a longitude, not a small-angle
 * approximation) -- so the resulting course measures precisely
 * `distanceKm` end to end regardless of length. */
export function createFlatCourse(distanceKm: number): GpxPoint[] {
  const distanceM = Math.max(0, distanceKm) * 1000;
  const pointCount = Math.max(2, Math.ceil(distanceM / RAW_POINT_SPACING_M) + 1);
  const points: GpxPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const d = (i / (pointCount - 1)) * distanceM;
    const latRad = 2 * Math.asin(Math.sin(d / (2 * EARTH_RADIUS_M)));
    points.push({ lat: (latRad * 180) / Math.PI, lon: 0, ele: 0, time: null, hr: null, power: null });
  }
  return points;
}
