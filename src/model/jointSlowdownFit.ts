// PLAN.md §14 Plan B, Stage 5: the genuine linear-combination fit -- one
// aerobic-fatigue-clock term, one impact/muscular-fatigue term, and surface
// category all fit JOINTLY (not as independent bolt-ons the way
// ceiling.ts's existing durabilityDriftPerDescentUnit mechanism tests one
// exposure basis at a time), so a run that's simultaneously "hard early"
// and "descending fast early" doesn't let one term's coefficient soak up
// variance that actually belongs to the other.
//
// Outcome is grade-adjusted pace (a GAP-style log-speed, via the Stage-0-
// validated Minetti cost ratio), NOT heart rate and NOT device power --
// deliberately. Stage 3 already showed device/GPS power is structurally
// blind to a cross-surface cost difference (a footpod's own reading barely
// tracks anything beyond speed+grade); HR is the one signal that survived
// that check, but pace is what the solver actually predicts and what a
// held-out finish-time backtest actually scores, and pace visibly responds
// to surface with no instrument-blindness detour required. HR stays an
// optional validation aside elsewhere, not this fit's dependent variable.
//
// Every term is estimated via WITHIN-RUN fixed effects (each run's own
// segments de-meaned before pooling) -- the same "compare a run to itself,
// not to other runs/days" discipline as withinRaceDescentDiagnostic.ts and
// Stage 3's within-run HR check, for the same reason: pooling raw values
// across runs would conflate a real slowdown-factor effect with cross-run/
// day-level differences (fitness that day, weather, how hard this run was
// chosen to be). Restricted to running gait (matching Stage 3's own
// default) so voluntary walk breaks -- a pacing CHOICE, not fatigue --
// don't get absorbed into the fatigue-clock coefficient.
//
// Collinearity is the central risk, not a footnote: cumulative hard work
// and cumulative descent-impact both rise ~monotonically within a run, so
// they compete for the same variance. This module reports each
// coefficient's Variance Inflation Factor (linearSolve.ts) precisely so a
// caller can see when two terms can't be separated, rather than silently
// trusting whichever one happens to win the normal equations' numerics.
//
// IMPORTANT: this fit's in-sample R^2/coefficients cannot crown a winning
// combination on their own -- a linear-in-accumulator fade is a different
// functional form from the existing exponential tau curve, and (per every
// other mechanism in this file) a good in-sample fit is close to
// guaranteed by construction. Candidate coefficients from here still have
// to clear Stage 5's held-out finish-time backtest before replacing
// anything in ceiling.ts.

import { costOfRunning } from "./minetti";
import type { SurfaceCategory } from "../gpx/pipeline";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { varianceInflationFactors, weightedLeastSquares } from "./linearSolve";

export type AerobicClockBasis = "elapsedHours" | "netWork" | "hardWork";
export type ImpactBasis = "descentMeters" | "descentImpact" | "descentImpactSquared" | "runningImpact";

export const SURFACE_CATEGORIES: SurfaceCategory[] = ["paved", "gravel", "dirt", "compacted", "path", "other"];
/** Arbitrary but fixed reference category every surface coefficient below
 * is measured relative to -- paved, since it's this athlete's most common
 * surface (see Stage 2's real-data sanity check) and matches Stage 3's own
 * "vs. paved" framing throughout. */
export const REFERENCE_SURFACE: SurfaceCategory = "paved";

export interface JointSlowdownFitOptions {
  aerobicClockBasis: AerobicClockBasis;
  impactBasis: ImpactBasis;
}

export interface JointSlowdownFitResult {
  /** Distinct runs that contributed at least one within-run-demeaned row --
   * the effective sample size for how well surface/clock/impact are
   * separated (see withinRaceDescentDiagnostic.ts's own "N is runs, not
   * segments" lesson, though unlike that per-run diagnostic, EVERY
   * qualifying segment here contributes a genuine within-run degree of
   * freedom, not just one point per run). */
  runCount: number;
  segmentCount: number;
  /** Column labels, parallel to coefficients/variableInflationFactors. */
  columns: string[];
  /** Fitted coefficient per column -- log-GAP change per unit of that
   * column (surface dummies: log-GAP offset vs. REFERENCE_SURFACE;
   * aerobicClock/impact: log-GAP change per unit of the chosen basis). */
  coefficients: number[];
  /** Within-run R^2 -- fraction of within-run log-GAP variance this model
   * explains. NOT comparable to a whole-model R^2 elsewhere in this
   * project (see this module's own doc for why this can't crown a winner
   * on its own). */
  rSquaredWithinRun: number;
  /** Parallel to columns -- see linearSolve.ts's own doc for the
   * rule-of-thumb concern threshold (~5-10) and what Infinity means. */
  variableInflationFactors: number[];
}

export function aerobicClockValue(seg: TaggedMonotonicSegment, basis: AerobicClockBasis): number | null {
  switch (basis) {
    case "elapsedHours":
      return seg.cumulativeElapsedHoursAtStart;
    case "netWork":
      return seg.cumulativeNetWorkJPerKgAtStart;
    case "hardWork":
      return seg.cumulativeHardWorkJPerKgAtStart;
  }
}

export function impactValue(seg: TaggedMonotonicSegment, basis: ImpactBasis): number {
  switch (basis) {
    case "descentMeters":
      return seg.cumulativeDescentMAtStart;
    case "descentImpact":
      return seg.cumulativeDescentImpactAtStart;
    case "descentImpactSquared":
      return seg.cumulativeDescentImpactSquaredAtStart;
    case "runningImpact":
      return seg.cumulativeRunningImpactAtStart;
  }
}

/**
 * Fits log-GAP ~ grade + grade^2 + surface + aerobicClock + impact jointly,
 * within-run fixed effects, weighted by segment duration. Returns null if
 * no run contributes at least two usable segments (fixed effects need
 * within-run variance to estimate anything) or if the resulting design is
 * singular (see linearSolve.ts's solveLinearSystem).
 *
 * grade/grade^2 are control regressors, not candidates: log-GAP already
 * divides out the Minetti cost curve's OWN grade dependence, but that
 * removes exactly the assumed shape, not necessarily the true one for this
 * athlete at every grade. Within a run, surface and grade are correlated
 * (Stage 3's own real-data check: path segments average ~10% grade vs.
 * paved's ~3%) -- so any residual Minetti mismatch concentrates on
 * whichever surface category happens to run steepest, and would otherwise
 * be misread as a surface effect. Including grade explicitly gives that
 * residual somewhere else to go before the surface dummies get credit for
 * it. A caught real bug, not a hypothetical: an earlier version of this
 * fit without these two columns produced a stable-looking path coefficient
 * across all twelve clock/impact combinations that could not be
 * distinguished from this exact grade-confound (see PLAN.md §14 stage 5).
 */
export function fitJointSlowdownModel(
  library: TaggedMonotonicSegment[],
  options: JointSlowdownFitOptions,
): JointSlowdownFitResult | null {
  const usable = library.filter(
    (s) =>
      s.gaitMode === "run" &&
      s.surfaceCategory !== undefined &&
      s.avgSpeedMs > 0 &&
      (options.aerobicClockBasis !== "hardWork" || s.cumulativeHardWorkJPerKgAtStart !== null),
  );
  if (usable.length === 0) return null;

  const byRun = new Map<string, TaggedMonotonicSegment[]>();
  for (const s of usable) {
    if (!byRun.has(s.runId)) byRun.set(s.runId, []);
    byRun.get(s.runId)!.push(s);
  }

  // Only categories actually PRESENT in this fit's usable segments get a
  // dummy column -- a category absent from the data (whether "other" never
  // occurs for this athlete, or a smaller real-data slice happens not to
  // include "path") would otherwise contribute an all-zero column after
  // within-run demeaning, making the design matrix singular for a reason
  // that has nothing to do with genuine collinearity.
  const presentCategories = new Set(usable.map((s) => s.surfaceCategory));
  const nonReferenceSurfaces = SURFACE_CATEGORIES.filter((c) => c !== REFERENCE_SURFACE && presentCategories.has(c));

  const columns = ["grade", "gradeSquared", ...nonReferenceSurfaces, "aerobicClock", "impact"];
  const k = columns.length;

  const rowsX: number[][] = [];
  const rowsY: number[] = [];
  const rowsW: number[] = [];
  let runCount = 0;

  for (const segs of byRun.values()) {
    if (segs.length < 2) continue;

    const raw: number[][] = segs.map((s) => [
      s.avgGradient,
      s.avgGradient * s.avgGradient,
      ...nonReferenceSurfaces.map((cat) => (s.surfaceCategory === cat ? 1 : 0)),
      aerobicClockValue(s, options.aerobicClockBasis)!,
      impactValue(s, options.impactBasis),
    ]);
    const y = segs.map((s) => Math.log(s.avgSpeedMs) + Math.log(costOfRunning(s.avgGradient)));
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
