// Terrain-surface durability drift (validated as a real, held-out-improving
// effect: a leave-one-out backtest across 31 real races showed 28
// improved, 0 regressed, when a fitted per-unpaved-meter drift term was
// added on top of the existing tau/fInf fit). Unlike descent (derived
// purely from the course's own elevation profile, already present on every
// segment), surface classification needs an external map-matching lookup
// (see attachSurfaceData below) -- there's no equivalent of
// descentStepForSegment that can compute this from GPX data alone.
//
// Only one exposure metric is offered here (cumulative unpaved meters),
// unlike descentImpact.ts's three candidate bases -- that investigation
// didn't know upfront which of raw/speed-weighted/speed-squared descent
// would matter, but the surface backtest already validated raw unpaved
// meters directly, so there's no open question to keep multiple readings
// alive for.

import type { CourseSegment } from "../gpx/pipeline";

/** Valhalla trace_attributes' own edge shape -- length is in KILOMETERS per
 * its API contract (`units: "kilometers"` in the response envelope), not
 * meters like this app's own CourseSegment.distance3D. */
export interface ValhallaSurfaceEdge {
  surface?: string;
  length: number;
}

/** Surface values observed in real Valhalla responses that count as
 * "unpaved" for this app's purposes -- trail/technical terrain, as opposed
 * to paved_smooth/paved/paved_rough (road/path pavement). */
const UNPAVED_SURFACES = new Set(["gravel", "dirt", "compacted", "path", "unpaved", "ground", "grass", "wood_chips"]);

/**
 * Classifies each segment as paved/unpaved by mapping Valhalla's sequential
 * edges (surface + length, in km, in route order) onto this course's own
 * resampled segments (cumulativeDistance3D, in meters) by cumulative-
 * distance fraction. Valhalla's own map-matched total distance can differ
 * slightly from this app's own pipeline (different snapping/resampling), so
 * this scales by the ratio of the two totals rather than assuming exact
 * agreement -- the same approach validated in this session's backtest.
 *
 * Returns a NEW segment array (segments are otherwise treated as immutable
 * pipeline output). If edges is empty or has no matched length, every
 * segment's surfaceUnpaved is left undefined ("no data"), not false --
 * see CourseSegment's own doc for why that distinction matters to callers.
 */
export function attachSurfaceData(segments: CourseSegment[], edges: ValhallaSurfaceEdge[]): CourseSegment[] {
  if (edges.length === 0) return segments;

  const edgeCumTotalKm: number[] = [0];
  const edgeCumUnpavedKm: number[] = [0];
  for (const e of edges) {
    edgeCumTotalKm.push(edgeCumTotalKm[edgeCumTotalKm.length - 1] + e.length);
    edgeCumUnpavedKm.push(edgeCumUnpavedKm[edgeCumUnpavedKm.length - 1] + (e.surface && UNPAVED_SURFACES.has(e.surface) ? e.length : 0));
  }
  const valhallaTotalKm = edgeCumTotalKm[edgeCumTotalKm.length - 1];
  const ourTotalM = segments[segments.length - 1]?.cumulativeDistance3D ?? 0;
  if (valhallaTotalKm <= 0 || ourTotalM <= 0) return segments;
  const scale = ourTotalM / 1000 / valhallaTotalKm; // our-km per valhalla-km

  function unpavedFractionAt(ourKm: number): number {
    const valhallaKm = ourKm / scale;
    let lo = 0;
    let hi = edgeCumTotalKm.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edgeCumTotalKm[mid] < valhallaKm) lo = mid + 1;
      else hi = mid;
    }
    const edgeIndex = Math.max(0, lo - 1);
    const edgeTotalKm = edgeCumTotalKm[edgeIndex + 1] - edgeCumTotalKm[edgeIndex];
    if (edgeTotalKm <= 0) return 0;
    return (edgeCumUnpavedKm[edgeIndex + 1] - edgeCumUnpavedKm[edgeIndex]) / edgeTotalKm;
  }

  return segments.map((s) => {
    const midpointKm = (s.cumulativeDistance3D - s.distance3D / 2) / 1000;
    return { ...s, surfaceUnpaved: unpavedFractionAt(midpointKm) >= 0.5 };
  });
}

export interface SurfaceStep {
  /** Meters of THIS segment's own distance counted as unpaved -- 0 if
   * classified as paved, or if no surface data is available at all. */
  unpavedM: number;
}

/**
 * Per-segment core shared by cumulativeUnpavedMForSegments and by callers
 * that need to track a running cumulative total alongside their own other
 * per-segment state (pacingFit.ts's buildEffortTrendPoints, solver.ts's
 * simulate) -- mirrors descentStepForSegment's role for descent.
 */
export function surfaceStepForSegment(seg: CourseSegment): SurfaceStep {
  if (seg.paused || !seg.surfaceUnpaved) return { unpavedM: 0 };
  return { unpavedM: seg.distance3D };
}

/** Total unpaved distance across a whole segment array -- for callers that
 * just want a summary number (e.g. the ceiling-loss sanity check this
 * feature was validated with), not a running per-segment total. */
export function cumulativeUnpavedMForSegments(segments: CourseSegment[]): number {
  let total = 0;
  for (const seg of segments) total += surfaceStepForSegment(seg).unpavedM;
  return total;
}

/** True if at least one segment carries surface data -- the basis for
 * deciding whether to apply a fitted surface-drift rate at all (see
 * solver.ts's simulate()): a course that was never surface-classified
 * should be silently unaffected, not treated as 0% unpaved. */
export function hasSurfaceData(segments: CourseSegment[]): boolean {
  return segments.some((s) => s.surfaceUnpaved !== undefined);
}
