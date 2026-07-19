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

export interface DescentStep {
  /** 0 if this segment doesn't count as descent (paused, no timing, or
   * climbing/flat). */
  descentM: number;
  /** null under the same conditions descentM is 0 for a non-descending
   * reason -- distinguishes "counts, but happens to be 0 descent" from
   * "doesn't count at all" for callers that need to know which. */
  speedMs: number | null;
}

/**
 * Per-segment core shared by the whole-array sums below *and* by callers
 * that need to track a running cumulative total alongside their own other
 * per-segment state (pacingFit.ts's buildEffortTrendPoints, solver.ts's
 * simulate) -- rather than recomputing this same elevation-delta/pause
 * logic in three places that could drift apart.
 *
 * Elevation delta is derived from consecutive segments' own smoothed
 * `elevation` (matching how the pipeline's own totalElevationGain/Loss are
 * computed), not the windowed `gradient` -- except for the very first
 * segment, which has no prior segment to diff against and falls back to
 * `gradient x distanceHorizontal`. That approximation touches at most one
 * out of typically hundreds/thousands of segments, a negligible edge effect.
 *
 * Callers must pass the *previous* segment's own `elevation` (null for the
 * first segment) and update their own running value to `seg.elevation`
 * after each call, unconditionally -- regardless of whether this step
 * "counted".
 */
export function descentStepForSegment(seg: CourseSegment, previousElevation: number | null): DescentStep {
  const eleDelta =
    previousElevation !== null ? seg.elevation - previousElevation : seg.gradient * seg.distanceHorizontal;

  if (seg.paused || seg.dtS === null || seg.dtS <= 0 || eleDelta >= 0) {
    return { descentM: 0, speedMs: null };
  }
  return { descentM: -eleDelta, speedMs: seg.distance3D / seg.dtS };
}

/**
 * Sums `descentMeters * speedWeight(speedMs)` across all non-paused,
 * descending segments. Shared by the linear and speed^2 variants below so a
 * fix to the elevation-delta/pause-exclusion logic can't drift between them.
 */
function sumDescentWeightedBySpeed(segments: CourseSegment[], speedWeight: (speedMs: number) => number): number {
  let impact = 0;
  let previousElevation: number | null = null;
  for (const seg of segments) {
    const { descentM, speedMs } = descentStepForSegment(seg, previousElevation);
    previousElevation = seg.elevation;
    if (speedMs !== null) impact += descentM * speedWeight(speedMs);
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
