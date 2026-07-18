// "Descent impact" -- the actual hypothesis under test for PLAN.md
// §12/§13 stage 5: it's not raw descent that drives eccentric loading and
// muscle damage, it's how fast that descent was covered. The same total
// elevation loss covered at a shuffle vs. bombed down a fire road plausibly
// costs very different amounts of muscle damage, which descent-per-km alone
// can't distinguish -- speed is exactly the missing factor.
//
// Computed per-segment (descent meters x a function of that segment's own
// speed, summed across the race) rather than total descent x whole-race
// average pace, so a fast downhill stretch and a slow flat/uphill stretch
// in the same race don't get blended into a number that reflects neither.
//
// Both variants below have speed baked directly into them, so they're
// confounded with avgIntensity the same way a fast race reads as both
// "intense" and "high impact" -- the meaningful comparison for either is
// against intensity, not against raw descentPerKm (they'll tend to beat raw
// descent for reasons that have nothing to do with descent at all, purely
// from the speed term).

import type { CourseSegment } from "../gpx/pipeline";

/**
 * Sums `descentMeters * speedWeight(speedMs)` across all non-paused,
 * descending segments. Shared by the linear and speed^2 variants below so a
 * fix to the elevation-delta/pause-exclusion logic can't drift between them.
 *
 * Elevation delta is derived from consecutive segments' own smoothed
 * `elevation` (matching how the pipeline's own totalElevationGain/Loss are
 * computed), not the windowed `gradient` -- except for the very first
 * segment, which has no prior segment to diff against and falls back to
 * `gradient x distanceHorizontal`. That approximation touches at most one
 * out of typically hundreds/thousands of segments, a negligible edge effect.
 */
function sumDescentWeightedBySpeed(segments: CourseSegment[], speedWeight: (speedMs: number) => number): number {
  let impact = 0;
  let previousElevation: number | null = null;
  for (const seg of segments) {
    const eleDelta =
      previousElevation !== null ? seg.elevation - previousElevation : seg.gradient * seg.distanceHorizontal;
    previousElevation = seg.elevation;

    if (seg.paused || seg.dtS === null || seg.dtS <= 0 || eleDelta >= 0) continue;
    const descentM = -eleDelta;
    const speedMs = seg.distance3D / seg.dtS;
    impact += descentM * speedWeight(speedMs);
  }
  return impact;
}

/**
 * Sum of (descent meters x speed m/s) across all non-paused, descending
 * segments. Units are m^2/s -- not a standard physiological quantity, just
 * an internally-consistent relative score for comparing races against each
 * other, the same role descent-per-km plays for raw descent.
 */
export function descentImpact(segments: CourseSegment[]): number {
  return sumDescentWeightedBySpeed(segments, (v) => v);
}

/**
 * Plain descent meters, no speed weighting -- shares the same elevation-
 * delta/pause-exclusion logic as the weighted variants (rather than
 * reimplementing it) for callers that need raw descent over an arbitrary
 * segment range, e.g. withinRaceDescentDiagnostic.ts's early-window sum.
 */
export function descentMeters(segments: CourseSegment[]): number {
  return sumDescentWeightedBySpeed(segments, () => 1);
}

/**
 * Speed-squared variant: sum of (descent meters x speed^2), proportional to
 * the kinetic energy being carried into each footstrike rather than speed
 * itself. Impact/eccentric-loading forces are often modeled as scaling with
 * kinetic energy, so this is at least as physiologically defensible as the
 * linear version -- offered as a second, independent reading rather than a
 * replacement, since there's no established result saying which scaling is
 * correct for this app's purposes. Units are m^3/s^2, same "relative score
 * only" caveat as descentImpact.
 */
export function descentImpactSquared(segments: CourseSegment[]): number {
  return sumDescentWeightedBySpeed(segments, (v) => v * v);
}
