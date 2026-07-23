// PLAN.md §14 Plan B, Stage 7: reframes Stage 5's joint slowdown-factor fit
// around an explicit, measured intensity term instead of leaving effort
// implicit.
//
// Stage 5's log-GAP outcome (log(speed) + log(Minetti cost at the
// segment's own grade)) assumes every segment is run at a roughly constant
// effort within a run (soaked up by the within-run fixed effect), so any
// pace difference at matched grade gets attributed to surface/clock/impact.
// That assumption doesn't hold segment-to-segment -- a recovery jog, an aid
// station approach, or a fatigue-driven pace drop all change how hard the
// athlete is trying WITHIN the same run, not just across runs/days. This
// module instead predicts raw log(speed) from an EXPLICIT intensity
// regressor (how hard the athlete's body is working right now) plus the
// same surface/grade/clock/impact terms, so "how much slower at the SAME
// intensity" is asked directly rather than assumed away.
//
// Three intensity bases, not one -- because none of the three candidate
// intensity readings is a free, non-circular measurement of effort:
//
// - "modelledPower" (avgMinettiGrossPowerWPerKg) is a DETERMINISTIC function
//   of this same segment's own grade and speed (netToGross(cost(grade) *
//   speed), see workAccumulation.ts). Regressing log(speed) on grade AND a
//   near-invertible function of (grade, speed) leaves almost no residual
//   variance for surface/clock/impact to explain -- expect R^2 -> ~1 and
//   every slowdown coefficient -> ~0. That collapse IS the finding (a
//   circularity fingerprint, not evidence terrain doesn't matter), and
//   intensityConditionedSlowdownFit.test.ts locks in exactly that shape so
//   it stays a demonstrated property, not a rediscovered surprise. It is
//   also not new information: Stage 5's own log-GAP outcome is already
//   equivalent to this quantity up to netToGross's additive resting term.
//
// - "measuredPower" (avgMeasuredPowerWPerKg, device/footpod power) looked
//   like the non-circular option, but Stage 3's own real-data check
//   (testStrydSurfaceSensitivity.ts) found it's nearly blind to surface at
//   matched speed+grade (1.01-1.03x across categories) -- meaning a
//   footpod's mechanical-output reading drops along with pace on rough
//   terrain rather than staying pinned while pace alone drops. Conditioning
//   on it risks absorbing the very slowdown this fit is trying to measure,
//   for the same reason as modelledPower, just less completely.
//
// - "pulse" (avgHeartRateBpm) is the one candidate that does NOT move in
//   lockstep with pace: internal effort (what HR tracks) does not drop
//   proportionally just because rough terrain slows the athlete down, so a
//   real surface-driven pace loss should stay visible at matched pulse+
//   grade. This is the same mechanism Stage 3's within-run HR check
//   originally found (HR survived the same test device power failed) --
//   generalized here into a joint regression with clock/impact included
//   alongside it, which that simpler matched-cell check never had.
//
// Consequently this module's own doc, and the real-data script built on
// top of it, treat "which slowdown coefficient stays identified and stable
// once intensity is held constant" as the comparison axis -- NOT raw R^2,
// which circularity inflates for exactly the arms that are least
// trustworthy. See fitJointSlowdownModel's doc for the shared within-run
// fixed-effects/WLS/VIF discipline this reuses unchanged.

import type { SurfaceCategory } from "../gpx/pipeline";
import {
  aerobicClockValue,
  impactValue,
  REFERENCE_SURFACE,
  SURFACE_CATEGORIES,
  type AerobicClockBasis,
  type ImpactBasis,
} from "./jointSlowdownFit";
import { varianceInflationFactors, weightedLeastSquares } from "./linearSolve";
import type { TaggedMonotonicSegment } from "./segmentLibrary";

export type IntensityBasis = "pulse" | "modelledPower" | "measuredPower";

export interface IntensityConditionedFitOptions {
  intensityBasis: IntensityBasis;
  aerobicClockBasis: AerobicClockBasis;
  impactBasis: ImpactBasis;
}

export interface IntensityConditionedFitResult {
  runCount: number;
  segmentCount: number;
  /** Column labels, parallel to coefficients/variableInflationFactors. The
   * first column is always "intensity" (pulse bpm, or W/kg for either power
   * basis). */
  columns: string[];
  /** Fitted coefficient per column -- log-speed change per unit of that
   * column (surface dummies: log-speed offset vs. REFERENCE_SURFACE). */
  coefficients: number[];
  /** Within-run R^2 -- see this module's own doc for why this is NOT
   * comparable across the three intensity bases (circularity inflates it
   * for modelledPower/measuredPower); compare surface/clock/impact
   * coefficient stability instead. */
  rSquaredWithinRun: number;
  /** Parallel to columns -- see linearSolve.ts's own doc for the
   * rule-of-thumb concern threshold (~5-10) and what Infinity means. */
  variableInflationFactors: number[];
}

function intensityValue(seg: TaggedMonotonicSegment, basis: IntensityBasis): number | null {
  switch (basis) {
    case "pulse":
      return seg.avgHeartRateBpm;
    case "modelledPower":
      return seg.avgMinettiGrossPowerWPerKg;
    case "measuredPower":
      return seg.avgMeasuredPowerWPerKg;
  }
}

/**
 * Fits log(speed) ~ intensity + grade + grade^2 + surface + aerobicClock +
 * impact jointly, within-run fixed effects, weighted by segment duration.
 * Returns null if no run contributes at least two usable segments or the
 * resulting design is singular (see linearSolve.ts's solveLinearSystem) --
 * expected, not a bug, for the modelledPower basis once grade is also in
 * the design (see this module's own doc).
 */
export function fitIntensityConditionedSlowdownModel(
  library: TaggedMonotonicSegment[],
  options: IntensityConditionedFitOptions,
): IntensityConditionedFitResult | null {
  const usable = library.filter(
    (s) =>
      s.gaitMode === "run" &&
      s.surfaceCategory !== undefined &&
      s.avgSpeedMs > 0 &&
      (options.aerobicClockBasis !== "hardWork" || s.cumulativeHardWorkJPerKgAtStart !== null) &&
      intensityValue(s, options.intensityBasis) !== null,
  );
  if (usable.length === 0) return null;

  const byRun = new Map<string, TaggedMonotonicSegment[]>();
  for (const s of usable) {
    if (!byRun.has(s.runId)) byRun.set(s.runId, []);
    byRun.get(s.runId)!.push(s);
  }

  const presentCategories = new Set(usable.map((s) => s.surfaceCategory));
  const nonReferenceSurfaces: SurfaceCategory[] = SURFACE_CATEGORIES.filter(
    (c) => c !== REFERENCE_SURFACE && presentCategories.has(c),
  );

  const columns = ["intensity", "grade", "gradeSquared", ...nonReferenceSurfaces, "aerobicClock", "impact"];
  const k = columns.length;

  const rowsX: number[][] = [];
  const rowsY: number[] = [];
  const rowsW: number[] = [];
  let runCount = 0;

  for (const segs of byRun.values()) {
    if (segs.length < 2) continue;

    const raw: number[][] = segs.map((s) => [
      intensityValue(s, options.intensityBasis)!,
      s.avgGradient,
      s.avgGradient * s.avgGradient,
      ...nonReferenceSurfaces.map((cat) => (s.surfaceCategory === cat ? 1 : 0)),
      aerobicClockValue(s, options.aerobicClockBasis)!,
      impactValue(s, options.impactBasis),
    ]);
    const y = segs.map((s) => Math.log(s.avgSpeedMs));
    const w = segs.map((s) => s.timeS);

    const sumW = w.reduce((a, b) => a + b, 0);
    if (sumW <= 0) continue;
    const meanY = y.reduce((sum, yi, i) => sum + w[i] * yi, 0) / sumW;
    const meanX = Array.from({ length: k }, (_, c) => raw.reduce((sum, row, i) => sum + w[i] * row[c], 0) / sumW);

    runCount++;
    for (let i = 0; i < segs.length; i++) {
      rowsX.push(raw[i].map((v, c) => v - meanX[c]));
      rowsY.push(y[i] - meanY);
      rowsW.push(w[i]);
    }
  }

  if (runCount === 0) return null;

  const fit = weightedLeastSquares(rowsX, rowsY, rowsW);
  if (!fit) return null;

  return {
    runCount,
    segmentCount: rowsX.length,
    columns,
    coefficients: fit.coefficients,
    rSquaredWithinRun: fit.rSquared,
    variableInflationFactors: varianceInflationFactors(rowsX, rowsW),
  };
}
