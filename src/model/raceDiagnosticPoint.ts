// Builds one race's tauDiagnostic.ts input point, self-consistently.
//
// avgIntensity ("avg effort") is actual power divided by the model's own
// predicted, duration-decaying ceiling -- which depends entirely on what
// tau is assumed. Using one global assumed tau for every race confounds
// avgIntensity with how much longer or shorter that race is than the
// assumed tau's own timescale: a race many multiples longer than the
// assumed tau reads as artificially high-effort, since the ceiling has
// already decayed to near-fInf long before the race itself is done.
// Confirmed empirically on real data: a ~30h race read as 94% effort
// against a 250min default tau, dropping to 57% once evaluated against its
// own ~2200min best-fit tau -- not a rounding difference, a confound that
// swamps the signal this diagnostic exists to detect.
//
// The fix: fit each race's own tau first (exactly what the diagnostic
// already reports as tauMin), then recompute avgIntensity against THAT
// tau instead of the caller's default -- so short and long races are
// judged on a ceiling shape that actually fits their own length, not one
// borrowed from whatever the athlete's current global settings happen to be.

import { analyzeRun, type AnalysisInputs } from "./analysis";
import type { CeilingParams } from "./ceiling";
import { descentImpact, descentImpactSquared } from "./descentImpact";
import type { PipelineResult } from "../gpx/pipeline";
import { buildEffortTrendPoints, fitTauMinutes } from "./pacingFit";
import type { RaceDiagnosticPoint } from "./tauDiagnostic";

export interface BuildRaceDiagnosticPointOptions extends Omit<AnalysisInputs, "ceilingParams" | "altitudeAdjustment"> {
  ceilingParams: CeilingParams;
  altitudeAdjustment: boolean;
}

/**
 * Null under the same conditions a diagnostic point was previously skipped
 * for: no timestamps, zero distance, or no reliable solo tau fit (hit a
 * search boundary -- an unreliable tau would make avgIntensity unreliable
 * too, since it's computed against that same tau).
 */
export function buildRaceDiagnosticPoint(
  label: string,
  course: PipelineResult,
  options: BuildRaceDiagnosticPointOptions,
): RaceDiagnosticPoint | null {
  if (!course.hasTimestamps) return null;
  const distanceKm = course.totalDistance3D / 1000;
  if (distanceKm <= 0) return null;

  const analysis = analyzeRun(course.segments, options);
  const effortTrendPoints = buildEffortTrendPoints(course.segments, analysis.segments, options.altitudeAdjustment);
  const soloTauFit = fitTauMinutes(effortTrendPoints, options.ceilingParams);
  if (!soloTauFit || soloTauFit.hitSearchBoundary) return null;

  const selfConsistentAnalysis = analyzeRun(course.segments, {
    ...options,
    ceilingParams: { ...options.ceilingParams, tauMin: soloTauFit.tauMin },
  });

  return {
    label,
    tauMin: soloTauFit.tauMin,
    avgIntensity: selfConsistentAnalysis.avgEffortFraction,
    descentPerKm: course.totalElevationLoss / distanceKm,
    descentImpactPerKm: descentImpact(course.segments) / distanceKm,
    descentImpactSquaredPerKm: descentImpactSquared(course.segments) / distanceKm,
  };
}
