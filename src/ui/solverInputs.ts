import type { CourseSegment } from "../gpx/pipeline";
import { findFlatPacedFinishTime, type SolverInputs } from "../model/solver";
import { predictMarginTheta } from "../model/pacingMarginFit";
import {
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FormInputs,
} from "./formInputs";

/** The solver's inputs for a course from the athlete's settings. Shared by
 * the Goal race tab's pacing plan and the training plan's race prediction,
 * so the two can't drift apart. */
export function buildSolverInputs(segments: CourseSegment[], formInputs: FormInputs): SolverInputs {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
  return {
    segments,
    bodyMassKg: formInputs.bodyMassKg,
    ceilingParams: resolveCeilingParams(formInputs),
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: formInputs.foPeakGPerMin },
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(formInputs),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
    unpavedCostMultiplier: formInputs.unpavedCostMultiplier,
    surfaceCostMultipliers: formInputs.surfaceCostMultipliers ?? undefined,
    anaerobicCapacityMin: formInputs.anaerobicCapacityMin,
    descentCapCurve: formInputs.descentCapCurve ?? undefined,
  };
}

/** The headline finish time the Pacing view shows without a target: the
 * athlete's own pacing-margin curve when fitted, else the zero-margin
 * ceiling. No surface lookup (a network call), so it can differ slightly
 * from the Pacing view on courses with much unpaved ground. */
export function predictFinishS(segments: CourseSegment[], formInputs: FormInputs, intakeGPerH = formInputs.intakeGPerH): number | null {
  if (segments.length === 0) return null;
  const inputs = buildSolverInputs(segments, { ...formInputs, intakeGPerH });
  const margin = formInputs.pacingMargin;
  const result = margin
    ? findFlatPacedFinishTime(inputs, { marginCurve: (h) => predictMarginTheta(h, margin) })
    : findFlatPacedFinishTime(inputs);
  return Number.isFinite(result.result.finishTimeS) ? result.result.finishTimeS : null;
}
