// PLAN.md §14 Plan B, Stage 4: net-locomotion-work and supra-LT2 "hard work"
// primitives -- two of the aerobic-fatigue-clock candidates from the §14
// shortlist (elapsed time, the third candidate, is already available as
// EffortTrendPoint.tHours with no accumulation of its own needed).
//
// Same step-function-plus-whole-array-reducer shape as descentImpact.ts:
// one shared per-segment primitive (workStepForSegment), used both by
// monotonicSegments.ts's own incremental accumulation across many segment
// boundaries in a single pass, and by withinRaceDescentDiagnostic.ts's
// slice-based early-window sums -- so a fix to the cost/hard-work formula
// can't drift between the two call sites.
//
// Both quantities are Minetti-cost-curve-derived from GPS speed+grade, the
// same basis as EffortTrendPoint.grossPowerWPerKg and analysis.ts's own
// grossPower -- NOT device power. That matters for how any correlation
// against the effort-fraction trend (also Minetti-derived) should be read:
// see withinRaceDescentDiagnostic.ts's module doc and PLAN.md §14 stage 4
// for why this isn't an independent instrument reading the way heart rate
// was for the surface question in Stage 3.

import type { CourseSegment } from "../gpx/pipeline";
import { costOfRunning, costOfWalking } from "./minetti";
import { netToGross } from "./energetics";
import { type CeilingParams, maxAerobicPower } from "./ceiling";

const DEFAULT_WALK_MAX_MS = 2.0;
/** Matches ceiling.ts's own DEFAULTS.lt2Fraction -- not exported there, so
 * duplicated here the same way monotonicSegments.ts already does. */
const DEFAULT_LT2_FRACTION = 0.85;

export interface WorkStep {
  /** Minetti net locomotion work this segment, J/kg -- 0 if unusable (paused/untimed). */
  netWorkJPerKg: number;
  /** Supra-LT2 "hard" work this segment, J/kg -- 0 if unusable or at/below LT2. */
  hardWorkJPerKg: number;
  /** Minetti-implied gross power/kg this segment -- 0 if unusable. Exposed so
   * callers that already need this quantity (monotonicSegments.ts's
   * avgMinettiGrossPowerWPerKg) don't recompute the same cost-curve call twice. */
  grossPowerWPerKg: number;
}

/**
 * Per-segment core shared by the whole-array sums below and by
 * monotonicSegments.ts's own incremental accumulation -- same role as
 * descentImpact.ts's descentStepForSegment.
 */
export function workStepForSegment(
  seg: CourseSegment,
  ceilingParams: CeilingParams = {},
  walkMaxMs: number = DEFAULT_WALK_MAX_MS,
): WorkStep {
  const dt = seg.dtS;
  if (seg.paused || dt === null || dt <= 0) {
    return { netWorkJPerKg: 0, hardWorkJPerKg: 0, grossPowerWPerKg: 0 };
  }

  const speedMs = seg.distance3D / dt;
  const cost = speedMs <= walkMaxMs ? costOfWalking(seg.gradient) : costOfRunning(seg.gradient);
  const netWorkJPerKg = cost * seg.distance3D;
  const grossPowerWPerKg = netToGross(cost * speedMs);
  const lt2Fraction = ceilingParams.lt2Fraction ?? DEFAULT_LT2_FRACTION;
  const hardWorkJPerKg = Math.max(0, grossPowerWPerKg - maxAerobicPower(seg.elevation, ceilingParams) * lt2Fraction) * dt;
  return { netWorkJPerKg, hardWorkJPerKg, grossPowerWPerKg };
}

function sumWork(
  segments: CourseSegment[],
  ceilingParams: CeilingParams,
  walkMaxMs: number,
  pick: (step: WorkStep) => number,
): number {
  let total = 0;
  for (const seg of segments) total += pick(workStepForSegment(seg, ceilingParams, walkMaxMs));
  return total;
}

/** Sum of Minetti net locomotion work (J/kg) across all usable segments in the array. */
export function netLocomotionWorkJPerKg(
  segments: CourseSegment[],
  ceilingParams: CeilingParams = {},
  walkMaxMs: number = DEFAULT_WALK_MAX_MS,
): number {
  return sumWork(segments, ceilingParams, walkMaxMs, (s) => s.netWorkJPerKg);
}

/** Sum of supra-LT2 "hard" work (J/kg) across all usable segments in the array. */
export function hardWorkJPerKg(
  segments: CourseSegment[],
  ceilingParams: CeilingParams = {},
  walkMaxMs: number = DEFAULT_WALK_MAX_MS,
): number {
  return sumWork(segments, ceilingParams, walkMaxMs, (s) => s.hardWorkJPerKg);
}
