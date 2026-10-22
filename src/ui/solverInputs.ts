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

export interface RacePrediction {
  finishS: number;
  /** Time-weighted gross power (W/kg) off the descents: the effort the
   * plan calls "race effort" (descents run below it, capped by the legs). */
  effortWPerKg: number | null;
}

/** The headline finish time the Pacing view shows without a target: the
 * athlete's own pacing-margin curve when fitted, else the zero-margin
 * ceiling. No surface lookup (a network call), so it can differ slightly
 * from the Pacing view on courses with much unpaved ground. */
export function predictRace(segments: CourseSegment[], formInputs: FormInputs, intakeGPerH = formInputs.intakeGPerH): RacePrediction | null {
  if (segments.length === 0) return null;
  const inputs = buildSolverInputs(segments, { ...formInputs, intakeGPerH });
  const margin = formInputs.pacingMargin;
  const { result } = margin
    ? findFlatPacedFinishTime(inputs, { marginCurve: (h) => predictMarginTheta(h, margin) })
    : findFlatPacedFinishTime(inputs);
  if (!Number.isFinite(result.finishTimeS)) return null;
  let time = 0;
  let work = 0;
  for (const r of result.segments) {
    if ((segments[r.index]?.gradient ?? 0) < -0.02) continue;
    time += r.timeS;
    work += r.timeS * r.grossPowerWPerKg;
  }
  return { finishS: result.finishTimeS, effortWPerKg: time > 0 ? work / time : null };
}

export function predictFinishS(segments: CourseSegment[], formInputs: FormInputs, intakeGPerH = formInputs.intakeGPerH): number | null {
  return predictRace(segments, formInputs, intakeGPerH)?.finishS ?? null;
}
