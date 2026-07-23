// GPX ingestion pipeline: parse -> resample to fixed 3D distance -> smooth
// elevation -> windowed gradient -> pause detect. See PLAN.md §5 "GPX
// pipeline" and §7 for the smoothing/segment-length defaults.
//
// Distance convention (PLAN.md §5): gradient is rise over HORIZONTAL
// (haversine) run; segment length used for cost/time/splits is the
// ALONG-SLOPE 3D distance = horizontalRun * sqrt(1 + gradient^2). Keep these
// two distinct — mixing them up is the easiest silent bug in this module.

const EARTH_RADIUS_M = 6371000;

export interface GpxPoint {
  lat: number;
  lon: number;
  /** Elevation in meters, or null if the GPX point had none. */
  ele: number | null;
  /** Timestamp, or null if the GPX point had none. */
  time: Date | null;
  /** Heart rate in bpm, from a Garmin TrackPointExtension, or null. */
  hr: number | null;
  /** Running power in watts, from a device extension (e.g. Stryd), or null. */
  power: number | null;
}

export interface PipelineOptions {
  /** Fixed 3D-distance resample spacing, in meters. PLAN.md §7 default: 50. */
  segmentLengthM?: number;
  /** Rolling elevation smoothing window, in meters. PLAN.md §7 default: 40. */
  smoothingWindowM?: number;
  /** Gradient window, in meters. Defaults to segmentLengthM (PLAN.md §5: 20-50m, never point-to-point). */
  gradientWindowM?: number;
  /** Below this speed a segment is considered a pause. Default 0.5 m/s. */
  pauseSpeedThresholdMs?: number;
}

/**
 * Finer surface vocabulary than CourseSegment.surfaceUnpaved's binary split
 * -- see src/model/surfaceExposure.ts's attachSurfaceData, which sets both
 * fields from the same underlying Valhalla lookup in one pass. "other"
 * covers the raw Valhalla values PLAN.md §12 stage 6 found no consistent
 * pattern for (ground/grass/wood_chips/bare "unpaved"), grouped rather than
 * given their own rarely-populated bins.
 */
export type SurfaceCategory = "paved" | "gravel" | "dirt" | "compacted" | "path" | "other";

export interface CourseSegment {
  index: number;
  /** Cumulative along-slope distance (m) at the end of this segment. */
  cumulativeDistance3D: number;
  /** This segment's horizontal (haversine) run, in meters. */
  distanceHorizontal: number;
  /** This segment's along-slope length, in meters. */
  distance3D: number;
  /** Smoothed elevation at the end of this segment, in meters. */
  elevation: number;
  /** Windowed, unclamped gradient (rise/run) for this segment. */
  gradient: number;
  /** Timestamp at the end of this segment, if the source GPX had timestamps. */
  time: Date | null;
  /** Elapsed time for this segment, in seconds, or null without timestamps. */
  dtS: number | null;
  /** True if this segment's average speed fell below the pause threshold. */
  paused: boolean;
  /** Heart rate (bpm) at the end of this segment, if the source GPX had it. */
  heartRateBpm: number | null;
  /** Measured running power (W) at the end of this segment, if the source GPX had it. */
  powerWatts: number | null;
  /**
   * True if this segment's terrain is classified as unpaved (gravel, dirt,
   * compacted, path) via an external map-matching lookup (see
   * src/model/surfaceExposure.ts's attachSurfaceData) -- not set by the
   * base pipeline itself, which has no network access and no opinion on
   * surface. Undefined means "no surface data available for this segment",
   * distinct from `false` ("known paved") -- a caller with a fitted
   * surface-drift rate but no surface data for a course should skip the
   * term entirely, not silently assume 0% unpaved.
   */
  surfaceUnpaved?: boolean;
  /**
   * Finer companion to surfaceUnpaved above -- same "undefined means no
   * data" contract, set by the same attachSurfaceData call. PLAN.md §14
   * Plan B bins on this directly (starting at the full vocabulary rather
   * than collapsing to surfaceUnpaved, per that section's own reasoning);
   * surfaceUnpaved is untouched and still what solver.ts/analysis.ts's
   * shipped unpavedCostMultiplier reads.
   */
  surfaceCategory?: SurfaceCategory;
}

export interface PipelineResult {
  segments: CourseSegment[];
  totalDistance3D: number;
  totalElevationGain: number;
  totalElevationLoss: number;
  hasElevation: boolean;
  hasTimestamps: boolean;
  hasHeartRate: boolean;
  hasPower: boolean;
}

const DEFAULT_SEGMENT_LENGTH_M = 50;
/**
 * 150, not 40 -- chosen to behavior-preserve the default at the moment
 * smoothing changed from a point-count radius to a real distance window
 * (see smoothMedianByDistance). The old (50, 40) combo floored to a 1-point
 * median radius, which at 50m spacing spanned 150m in practice regardless of
 * the "40" label; 150 keeps that same real-world smoothing extent now that
 * the number means what it says, rather than silently changing what a
 * fresh install's default course looks like.
 */
const DEFAULT_SMOOTHING_WINDOW_M = 150;
const DEFAULT_PAUSE_SPEED_MS = 0.5;

function attr(tagAttrs: string, name: string): string | null {
  const m = tagAttrs.match(new RegExp(`\\b${name}=["']([^"']+)["']`));
  return m ? m[1] : null;
}

/** Parses `<trkpt>` elements out of GPX XML. Deliberately regex-based (not
 * DOMParser) so it runs identically in the browser and in Node tests. */
export function parseGpx(xml: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let match: RegExpExecArray | null;
  while ((match = trkptRe.exec(xml))) {
    const [, tagAttrs, body] = match;
    const lat = attr(tagAttrs, "lat");
    const lon = attr(tagAttrs, "lon");
    if (lat === null || lon === null) continue;
    const eleMatch = body.match(/<ele>\s*([-\d.]+)\s*<\/ele>/);
    const timeMatch = body.match(/<time>\s*([^<]+?)\s*<\/time>/);
    // hr/cadence come from Garmin's TrackPointExtension (gpxtpx: namespace);
    // power has no standard GPX extension, so devices vary -- Stryd/Garmin
    // exports seen so far use a bare, unnamespaced <power> tag.
    const hrMatch = body.match(/<(?:gpxtpx:)?hr>\s*(\d+)\s*<\/(?:gpxtpx:)?hr>/);
    const powerMatch = body.match(/<(?:gpxtpx:)?power>\s*(\d+)\s*<\/(?:gpxtpx:)?power>/);
    points.push({
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      ele: eleMatch ? parseFloat(eleMatch[1]) : null,
      time: timeMatch ? new Date(timeMatch[1]) : null,
      hr: hrMatch ? parseFloat(hrMatch[1]) : null,
      power: powerMatch ? parseFloat(powerMatch[1]) : null,
    });
  }
  return points;
}

/** Great-circle (horizontal) distance between two lat/lon points, in meters. */
export function haversineDistance(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export interface RawPoint {
  /** Cumulative horizontal distance from the start, in meters. */
  distanceM: number;
  /** Raw, unsmoothed elevation, in meters (0 if the point had none). */
  elevation: number;
}

export interface RawCourseStats {
  /** Point-to-point horizontal distance, no resampling/smoothing at all. */
  distanceM: number;
  /** Sum of positive point-to-point elevation deltas, no smoothing at all. */
  elevationGain: number;
  /** (distance, elevation) at every raw point, for overlaying against the processed profile. */
  series: RawPoint[];
}

/**
 * Point-to-point stats straight off the raw GPX points -- no resampling, no
 * smoothing. Useful as a reference for how much processing is changing
 * (PLAN.md §5's "let the user calibrate smoothing to a known course
 * vertical"), not as a "true" figure: raw GPS/barometric noise inflates this
 * gain, often substantially, so it's one endpoint of the tradeoff, not the
 * answer.
 */
export function rawCourseStats(points: GpxPoint[]): RawCourseStats {
  const series: RawPoint[] = [];
  let distanceM = 0;
  let elevationGain = 0;
  if (points.length > 0) series.push({ distanceM: 0, elevation: points[0].ele ?? 0 });
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineDistance(points[i - 1], points[i]);
    const e0 = points[i - 1].ele ?? 0;
    const e1 = points[i].ele ?? 0;
    if (e1 > e0) elevationGain += e1 - e0;
    series.push({ distanceM, elevation: e1 });
  }
  return { distanceM, elevationGain, series };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Resamples raw points onto a uniform grid, spaced `spacingM` apart by
 * approximate 3D (straight-line) distance. Interpolates lat/lon/ele/time/hr/power. */
function resample(points: GpxPoint[], spacingM: number): GpxPoint[] {
  if (points.length < 2) return points.slice();

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const horizontal = haversineDistance(points[i - 1], points[i]);
    const eleDelta = (points[i].ele ?? 0) - (points[i - 1].ele ?? 0);
    cumulative.push(
      cumulative[i - 1] + Math.sqrt(horizontal * horizontal + eleDelta * eleDelta),
    );
  }
  const total = cumulative[cumulative.length - 1];

  const resampled: GpxPoint[] = [];
  let bracketStart = 0;
  for (let target = 0; target <= total; target += spacingM) {
    while (
      bracketStart < cumulative.length - 2 &&
      cumulative[bracketStart + 1] < target
    ) {
      bracketStart++;
    }
    const d0 = cumulative[bracketStart];
    const d1 = cumulative[bracketStart + 1];
    const t = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    const p0 = points[bracketStart];
    const p1 = points[bracketStart + 1];
    resampled.push({
      lat: lerp(p0.lat, p1.lat, t),
      lon: lerp(p0.lon, p1.lon, t),
      ele: p0.ele !== null && p1.ele !== null ? lerp(p0.ele, p1.ele, t) : (p0.ele ?? p1.ele),
      time:
        p0.time !== null && p1.time !== null
          ? new Date(lerp(p0.time.getTime(), p1.time.getTime(), t))
          : (p0.time ?? p1.time),
      hr: p0.hr !== null && p1.hr !== null ? lerp(p0.hr, p1.hr, t) : (p0.hr ?? p1.hr),
      power: p0.power !== null && p1.power !== null ? lerp(p0.power, p1.power, t) : (p0.power ?? p1.power),
    });
  }
  // Always include the final raw point exactly, so the course endpoint is preserved.
  const last = points[points.length - 1];
  const lastResampled = resampled[resampled.length - 1];
  if (!lastResampled || haversineDistance(lastResampled, last) > 1e-6) {
    resampled.push(last);
  }
  return resampled;
}

/**
 * Rolling median smoothing over a genuine real-world distance window (not a
 * fixed point count). Point-count radii are wrong here: converting a meters
 * window to a point-count radius via `round(windowM / spacingM / 2)` and
 * flooring at 1 point (as an earlier version of this function did) collapses
 * to the *same* 1-point radius for almost any windowM smaller than roughly
 * 3x the point spacing -- so "smoothing window" silently stopped doing
 * anything across most of its useful range, and "segment length" ended up
 * secretly controlling the real smoothing extent instead (since a 1-point
 * radius spans 3x whatever the spacing happens to be). Walking a real
 * distance window sidesteps that entirely: it means the same thing whether
 * `points` are raw, unevenly-spaced GPS fixes or an evenly resampled grid.
 */
function smoothMedianByDistance(points: GpxPoint[], windowM: number): number[] {
  const eles = points.map((p) => p.ele ?? 0);
  if (windowM <= 0 || points.length < 2) return eles;

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineDistance(points[i - 1], points[i]));
  }

  const half = windowM / 2;
  const smoothed: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < points.length; i++) {
    while (lo < i && cumulative[i] - cumulative[lo] > half) lo++;
    while (hi < points.length - 1 && cumulative[hi + 1] - cumulative[i] <= half) hi++;
    const window = eles.slice(lo, hi + 1).sort((a, b) => a - b);
    smoothed.push(window[Math.floor(window.length / 2)]);
  }
  return smoothed;
}

function metersToPointRadius(windowM: number, spacingM: number): number {
  return Math.max(1, Math.round(windowM / spacingM / 2));
}

/**
 * Runs the full GPX pipeline: resample to a fixed 3D-distance grid, smooth
 * elevation, compute a windowed (non-point-to-point) gradient, and flag
 * paused segments when timestamps are present.
 *
 * Pause detection operates at segment granularity: a stop's raw GPS fixes
 * collapse into a near-zero distance range during resampling, so the pause
 * shows up as one segment with an anomalously long elapsed time rather than
 * being pinpointed to the exact meter it occurred. That's sufficient for
 * excluding rest time from moving pace (PLAN.md §4 analysis mode).
 */
export function runPipeline(
  points: GpxPoint[],
  options: PipelineOptions = {},
): PipelineResult {
  const segmentLengthM = options.segmentLengthM ?? DEFAULT_SEGMENT_LENGTH_M;
  const smoothingWindowM = options.smoothingWindowM ?? DEFAULT_SMOOTHING_WINDOW_M;
  const gradientWindowM = options.gradientWindowM ?? segmentLengthM;
  const pauseSpeedThresholdMs =
    options.pauseSpeedThresholdMs ?? DEFAULT_PAUSE_SPEED_MS;

  const hasElevation = points.some((p) => p.ele !== null);
  const hasTimestamps = points.some((p) => p.time !== null);
  const hasHeartRate = points.some((p) => p.hr !== null);
  const hasPower = points.some((p) => p.power !== null);

  // Smooth on the raw points first, using a real distance window -- keeps
  // smoothing extent independent of whatever resample spacing is chosen next.
  const smoothedRawEle = smoothMedianByDistance(points, smoothingWindowM);
  const smoothedPoints = points.map((p, i) => ({ ...p, ele: smoothedRawEle[i] }));

  const resampled = resample(smoothedPoints, segmentLengthM);
  const smoothedEle = resampled.map((p) => p.ele ?? 0);
  const gradientRadius = metersToPointRadius(gradientWindowM, segmentLengthM);

  const segments: CourseSegment[] = [];
  let cumulativeDistance3D = 0;
  let totalElevationGain = 0;
  let totalElevationLoss = 0;

  for (let i = 1; i < resampled.length; i++) {
    const distanceHorizontal = haversineDistance(resampled[i - 1], resampled[i]);

    const gLo = Math.max(0, i - gradientRadius);
    const gHi = Math.min(resampled.length - 1, i + gradientRadius);
    const windowHorizontal = haversineDistance(resampled[gLo], resampled[gHi]);
    const windowEleDelta = smoothedEle[gHi] - smoothedEle[gLo];
    const gradient = windowHorizontal > 0 ? windowEleDelta / windowHorizontal : 0;

    const distance3D = distanceHorizontal * Math.sqrt(1 + gradient * gradient);
    cumulativeDistance3D += distance3D;

    const eleDelta = smoothedEle[i] - smoothedEle[i - 1];
    if (eleDelta > 0) totalElevationGain += eleDelta;
    else totalElevationLoss += -eleDelta;

    let paused = false;
    let dtS: number | null = null;
    if (hasTimestamps && resampled[i - 1].time && resampled[i].time) {
      dtS = (resampled[i].time!.getTime() - resampled[i - 1].time!.getTime()) / 1000;
      const speed = dtS > 0 ? distance3D / dtS : 0;
      paused = speed < pauseSpeedThresholdMs;
    }

    segments.push({
      index: i - 1,
      cumulativeDistance3D,
      distanceHorizontal,
      distance3D,
      elevation: smoothedEle[i],
      gradient,
      time: resampled[i].time,
      dtS,
      paused,
      heartRateBpm: resampled[i].hr,
      powerWatts: resampled[i].power,
    });
  }

  return {
    segments,
    totalDistance3D: cumulativeDistance3D,
    totalElevationGain,
    totalElevationLoss,
    hasElevation,
    hasTimestamps,
    hasHeartRate,
    hasPower,
  };
}
