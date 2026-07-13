// "Descent impact" -- the actual hypothesis under test for PLAN.md
// §12/§13 stage 5: it's not raw descent that drives eccentric loading and
// muscle damage, it's how fast that descent was covered. The same total
// elevation loss covered at a shuffle vs. bombed down a fire road plausibly
// costs very different amounts of muscle damage, which descent-per-km alone
// can't distinguish -- speed is exactly the missing factor.
//
// Computed per-segment (descent meters x that segment's own speed, summed
// across the race) rather than total descent x whole-race average pace, so
// a fast downhill stretch and a slow flat/uphill stretch in the same race
// don't get blended into a number that reflects neither.

import type { CourseSegment } from "../gpx/pipeline";

/**
 * Sum of (descent meters x speed m/s) across all non-paused, descending
 * segments. Units are m^2/s -- not a standard physiological quantity, just
 * an internally-consistent relative score for comparing races against each
 * other, the same role descent-per-km plays for raw descent.
 *
 * Elevation delta is derived from consecutive segments' own smoothed
 * `elevation` (matching how the pipeline's own totalElevationGain/Loss are
 * computed), not the windowed `gradient` -- except for the very first
 * segment, which has no prior segment to diff against and falls back to
 * `gradient x distanceHorizontal`. That approximation touches at most one
 * out of typically hundreds/thousands of segments, a negligible edge effect.
 */
export function descentImpact(segments: CourseSegment[]): number {
  let impact = 0;
  let previousElevation: number | null = null;
  for (const seg of segments) {
    const eleDelta =
      previousElevation !== null ? seg.elevation - previousElevation : seg.gradient * seg.distanceHorizontal;
    previousElevation = seg.elevation;

    if (seg.paused || seg.dtS === null || seg.dtS <= 0 || eleDelta >= 0) continue;
    const descentM = -eleDelta;
    const speedMs = seg.distance3D / seg.dtS;
    impact += descentM * speedMs;
  }
  return impact;
}
