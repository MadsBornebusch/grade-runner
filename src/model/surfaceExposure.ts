// Terrain-surface classification, from an external map-matching lookup
// (Valhalla) -- unlike descent (derived purely from the course's own
// elevation profile, already present on every segment), surface needs a
// network call, so this module owns mapping that response onto segments
// rather than computing anything from GPX data alone.
//
// Two rejected designs preceded the flat cost multiplier this app ships
// today (see solver.ts's own doc comment on unpavedCostMultiplier for the
// full comparison): a cumulative-exposure durability-drift term (mirroring
// descentImpact.ts's mechanism) fit far worse in a leave-one-out backtest,
// and a hard speed cap on unpaved terrain fit worse too once compared
// honestly. See fitUnpavedCostMultiplierAcrossRaces in pacingFit.ts and the
// cost multiplier applied in solver.ts/analysis.ts -- this module now only
// owns the classification step, not any exposure/accumulation logic.

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
