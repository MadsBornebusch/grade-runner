// A recorded "run" can silently include a train/bus/car leg -- a watch left
// running while commuting to or from a trailhead, or across a stop in the
// middle. Found on a real 2025-10-19 activity: GPS jumped 9.1km in 826s and
// 19km in 1362s, both landing at ~11-14 m/s average with recorded power at
// 0 -- well beyond any plausible running speed, but easy to miss since the
// pipeline's fixed-distance resample (see pipeline.ts's `resample`) linearly
// interpolates straight across a raw gap like that, smearing one huge jump
// into many ordinary-looking segments each showing a smooth (if fast) pace,
// rather than one obvious spike. Detection therefore has to run on the RAW,
// pre-resample points -- never on already-resampled/segmented output.
import { type GpxPoint, haversineDistance } from "./pipeline";

export interface TransitGapOptions {
  /** m/s. A single inter-point step implying a sustained speed above this is
   * physically implausible for running (deliberately generous -- well above
   * any real sustained trail-race pace) and is treated as transit, not GPS
   * noise. Default 7 (≈ 2:23/km). */
  maxPlausibleRunSpeedMs?: number;
  /** Steps under this distance are never flagged, even above the speed
   * threshold -- ordinary GPS jitter can transiently imply a high speed over
   * a trivial distance, and splitting a real run over that would be worse
   * than the problem this guards against. Default 300 (m). */
  minGapDistanceM?: number;
}

const DEFAULT_MAX_PLAUSIBLE_RUN_SPEED_MS = 7;
const DEFAULT_MIN_GAP_DISTANCE_M = 300;

export interface TransitGap {
  /** Index into the input array of the point just before the gap. */
  beforeIndex: number;
  /** Index into the input array of the point just after the gap (the start of the next leg). */
  afterIndex: number;
  distanceM: number;
  durationS: number;
  impliedSpeedMs: number;
}

/** Finds transit-like gaps in raw GPX points without splitting them -- used
 * by splitAtTransitGaps below, and exposed separately so callers that just
 * want to report "N gaps found" don't need to also compute the split. */
export function detectTransitGaps(points: GpxPoint[], opts: TransitGapOptions = {}): TransitGap[] {
  const maxSpeed = opts.maxPlausibleRunSpeedMs ?? DEFAULT_MAX_PLAUSIBLE_RUN_SPEED_MS;
  const minDist = opts.minGapDistanceM ?? DEFAULT_MIN_GAP_DISTANCE_M;
  const gaps: TransitGap[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a.time || !b.time) continue;
    const durationS = (b.time.getTime() - a.time.getTime()) / 1000;
    if (durationS <= 0) continue;
    const distanceM = haversineDistance(a, b);
    const impliedSpeedMs = distanceM / durationS;
    if (impliedSpeedMs > maxSpeed && distanceM > minDist) {
      gaps.push({ beforeIndex: i - 1, afterIndex: i, distanceM, durationS, impliedSpeedMs });
    }
  }
  return gaps;
}

/**
 * Splits raw GPX points into contiguous legs at any detected transit gap,
 * dropping the gap itself (the two points bracketing it stay, one ending a
 * leg and one starting the next -- nothing between them, since a genuine
 * transit gap is a single oversized step, not a run of noisy points).
 * Returns `[points]` unchanged (one leg) when no gap is found -- the
 * overwhelmingly common case, so this is a safe default for every caller
 * that currently treats one stored run as one course.
 */
export function splitAtTransitGaps(points: GpxPoint[], opts: TransitGapOptions = {}): GpxPoint[][] {
  const gaps = detectTransitGaps(points, opts);
  if (gaps.length === 0) return [points];

  const legs: GpxPoint[][] = [];
  let legStart = 0;
  for (const gap of gaps) {
    legs.push(points.slice(legStart, gap.beforeIndex + 1));
    legStart = gap.afterIndex;
  }
  legs.push(points.slice(legStart));
  return legs;
}
