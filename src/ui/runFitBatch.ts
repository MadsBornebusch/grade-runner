// Runs the "fit full athlete model" pipeline (tau/fInf, terrain surface
// cost, HR-effort calibration, pacing margin, tau confidence interval) as a
// module-level process, same pattern and same reason as
// autoFetchRuns.ts/backfillRuns.ts: Settings intentionally unmounts
// RunLibraryPanel when closed, and this pipeline can take several seconds
// across a real run library. Before this existed, closing Settings
// mid-fit silently abandoned the visible progress and results (the
// onApply* callbacks, being parent-owned, still fired correctly -- the fit
// itself wasn't lost, only the UI's knowledge of it), and reopening looked
// exactly like nothing had happened, with nothing stopping a second,
// genuinely concurrent fit if the button was clicked again. Moving the
// whole pipeline here means it keeps running (and stays visible) across
// any number of mounts/unmounts.

import type { CourseSegment, GpxPoint } from "../gpx/pipeline";
import { runPipeline } from "../gpx/pipeline";
import { splitAtTransitGaps } from "../gpx/transitGap";
import { analyzeRun } from "../model/analysis";
import { maxAerobicPower, type CeilingParams } from "../model/ceiling";
import {
  buildThresholdPowerAnchorPoints,
  fitHrToPowerCalibrationAcrossRaces,
  fitHrToPowerCalibrationFromThresholds,
  type HrPowerCalibration,
} from "../model/hrCalibration";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  fitSurfaceCostMultipliersFromIntensity,
  fitTauFInfWithSupportGate,
  type EffortTrendPoint,
  type FInfTauFitResult,
  type MultiRaceTauFitResult,
  type SafeFitResult,
  type SurfaceCostMultiplierFitResult,
  type TauConfidenceInterval,
} from "../model/pacingFit";
import { fitPacingMarginAcrossRaces, type PacingMarginFitResult } from "../model/pacingMarginFit";
import { buildSegmentLibrary } from "../model/segmentLibrary";
import { DURABILITY_MIN_DURATION_S } from "../model/suggestRuns";
import { attachSurfaceData } from "../model/surfaceExposure";
import { setStoredRunSurfaceEdges, type StoredRun } from "../storage/runLibrary";
import type { FormInputs } from "./formInputs";
import { resolveGlycogenStoreG, resolveLt1Lt2Fractions } from "./formInputs";
import { ensurePointsForRun } from "./autoFetchRuns";
import { fetchSurfaceEdges } from "./surfaceLookup";

/** A run's own calendar date, for recency-weighting the multi-race fit --
 * Strava summaries carry it directly; GPX-derived runs (manual upload, or a
 * Strava run whose points have already been fetched) fall back to the
 * first point's own timestamp. Null if neither is available. */
export function runDate(run: StoredRun): Date | null {
  if (run.date) return new Date(run.date);
  const firstPointTime = run.points?.[0]?.time;
  return firstPointTime ?? null;
}

/** A watch left running across a train/bus/car leg can hide a transit hop
 * inside an otherwise-real run (see gpx/transitGap.ts) -- fed straight into
 * a fit, that shows up as impossible pace and can badly distort tau/fInf.
 * Splits at any detected gap and processes each leg as its own course.
 * Below this only applies when a split actually happened -- an unsplit run
 * is used regardless of its own length, unchanged from prior behavior. */
export const MIN_LEG_DISTANCE_KM = 5;

/** A starting heuristic, not a tuned optimum -- at least half the variance
 * in this athlete's effort explained by HR alone before auto-applying the
 * HR-effort calibration. */
export const MIN_HR_CALIBRATION_R_SQUARED = 0.5;

/** Same role as MIN_INFORMATIVE_RACES for the tau/fInf fits, scaled up: this
 * fit pools individual runs (not just races), so a handful isn't enough to
 * trust the per-category split even though the regression itself won't
 * refuse to return a result. */
export const MIN_SURFACE_FIT_RUNS = 10;

/** Fetches and caches Valhalla surface classification for a run; a no-op
 * if already cached. Returns null on any failure (or if this run has no
 * stable id to cache against) -- callers treat that exactly like "no
 * surface data available", never as an error to surface to the user (see
 * surfaceLookup.ts's own contract). A prior failed attempt is naturally
 * retried here too, since it's never cached as a permanent result. */
async function ensureSurfaceData(run: StoredRun, points: GpxPoint[]) {
  if (run.surfaceEdges) return run.surfaceEdges;
  const edges = await fetchSurfaceEdges(points);
  if (edges && edges.length > 0) await setStoredRunSurfaceEdges(run.id, edges);
  return edges;
}

export interface RunFitResult {
  fitResult: MultiRaceTauFitResult | null;
  fInfFitResult: FInfTauFitResult | null;
  safeFitTier: SafeFitResult["tier"] | null;
  surfaceFit: SurfaceCostMultiplierFitResult | null;
  hrCalibrationFit: HrPowerCalibration | null;
  marginFit: PacingMarginFitResult | null;
  transitGapCount: number;
  excludedForDurationCount: number;
  races: EffortTrendPoint[][];
  raceDates: (Date | null)[];
  tauCI: TauConfidenceInterval | "insufficient" | null;
}

export interface RunFitStatus {
  running: boolean;
  result: RunFitResult | null;
  error: string | null;
}

let status: RunFitStatus = { running: false, result: null, error: null };
const listeners = new Set<() => void>();

function setStatus(next: RunFitStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeToRunFit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRunFitStatus(): RunFitStatus {
  return status;
}

/** For "Clear all stored runs" -- a stale fit result would otherwise keep
 * showing (and keep being treated as the current one for e.g. the tau
 * confidence-interval button) after the data it was fit from is gone. A
 * no-op while a fit is actually running (clearing runs mid-fit doesn't
 * cancel it -- the same "let it finish, don't corrupt in-flight state"
 * discipline as everywhere else in this file). */
export function resetRunFitStatus(): void {
  if (status.running) return;
  setStatus({ running: false, result: null, error: null });
}

export interface RunFitCallbacks {
  onApplyTau: (tauMin: number) => void;
  onApplyFInf: (fInf: number) => void;
  onApplySurfaceCostMultipliers: (multipliers: SurfaceCostMultiplierFitResult["surfaceCostMultipliers"]) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onApplyPacingMargin: (fit: PacingMarginFitResult) => void;
  onRacesFitted?: (races: EffortTrendPoint[][], raceDates: (Date | null)[]) => void;
}

/**
 * Idempotent against concurrent calls, same discipline as
 * autoFetchRuns.ts/backfillRuns.ts -- a second call while one is already
 * running is a silent no-op, so it's safe to call from every mount/remount
 * (including reopening Settings mid-fit) without risking a duplicate,
 * competing fit. The auto-apply gating (which tier's tau/fInf to apply,
 * the R²/run-count bars for surface cost and HR calibration) lives here
 * now too, alongside the fit itself, since it's part of the same atomic
 * operation -- not left for the caller to re-derive from the result.
 */
export async function runFitBatch(
  readyRuns: StoredRun[],
  formInputs: FormInputs,
  ceilingParams: CeilingParams,
  halfLifeDays: number,
  callbacks: RunFitCallbacks,
): Promise<void> {
  if (status.running) return;
  setStatus({ running: true, result: null, error: null });

  try {
    const races: EffortTrendPoint[][] = [];
    const raceDates: (Date | null)[] = [];
    // Every leg with usable segments contributes here, NOT just the ones
    // long/race-paced enough for the tau/fInf pool below -- unlike the
    // flat multiplier this replaced, fitSurfaceCostMultipliersFromIntensity
    // conditions on the athlete's own recorded heart rate as the effort
    // signal rather than the solver's max-sustainable-effort assumption,
    // so an easy run's own paved-vs-unpaved segments are still valid,
    // matched-intensity information -- more data, not contamination (see
    // that function's own doc).
    const libraryInputs: { runId: string; segments: CourseSegment[] }[] = [];
    // Unlike races/raceDates below, deliberately NOT gated on
    // DURABILITY_MIN_DURATION_S -- the pacing-margin curve specifically
    // needs its SHORT end (a 10km race anchors near theta=1, the whole
    // reason a margin curve rather than a flat scalar is worth fitting;
    // see pacingMarginFit.ts's own doc). Only ever populated from
    // user-confirmed races (raceTag === "race"), never a name heuristic.
    const confirmedRaceTrendPoints: EffortTrendPoint[][] = [];
    const confirmedRaceNames: string[] = [];
    let detectedTransitGaps = 0;
    let excludedForDuration = 0;

    for (const run of readyRuns) {
      const points = await ensurePointsForRun(run);
      const pointLegs = splitAtTransitGaps(points);
      detectedTransitGaps += pointLegs.length - 1;
      // Cached surface edges were fetched (and are indexed by cumulative
      // distance) against the run's FULL point sequence -- they don't
      // decompose per leg, so a split run is treated as having no surface
      // data at all rather than risk misattributing edges from one leg
      // onto another's segments. Split runs are rare (most have no
      // transit gap at all, see transitGap.ts), so this only costs the
      // surface-cost fit a little data in the uncommon case.
      const surfaceEdges = pointLegs.length === 1 ? await ensureSurfaceData(run, points) : null;
      for (let i = 0; i < pointLegs.length; i++) {
        const legPoints = pointLegs[i];
        const course = runPipeline(legPoints);
        if (!course.hasTimestamps) continue;
        if (pointLegs.length > 1 && course.totalDistance3D / 1000 < MIN_LEG_DISTANCE_KM) continue;
        const segments = surfaceEdges ? attachSurfaceData(course.segments, surfaceEdges) : course.segments;
        libraryInputs.push({ runId: pointLegs.length > 1 ? `${run.id}-leg${i + 1}` : run.id, segments });
        const analysis = analyzeRun(segments, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH },
          glycogenStoreG: resolveGlycogenStoreG(formInputs),
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        if (run.raceTag === "race") {
          confirmedRaceTrendPoints.push(buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment));
          confirmedRaceNames.push(pointLegs.length > 1 ? `${run.name} (leg ${i + 1})` : run.name);
        }
        // Below DURABILITY_MIN_DURATION_S, a run can't span a meaningful
        // fraction of any realistic tau -- pooling it in anyway doesn't
        // just fail to help, it can actively distort the search: enough
        // near-flat short runs pooled alongside a handful of long races
        // can pull tau toward an implausibly small value that trivially
        // "fits" the short runs' near-zero slope without reflecting real
        // fatigue-decay behavior at all.
        if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) {
          excludedForDuration++;
          continue;
        }
        races.push(buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment));
        raceDates.push(pointLegs.length > 1 ? (legPoints[0]?.time ?? runDate(run)) : runDate(run));
      }
    }

    const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates, halfLifeDays });

    // Per-category surface cost, conditioned on recorded heart rate as the
    // effort signal instead of the solver's own max-sustainable-effort
    // assumption. Cheap relative to a finish-time fit: a single regression
    // over the whole library, no per-candidate solver simulation.
    const library = buildSegmentLibrary(libraryInputs, { bodyMassKg: formInputs.bodyMassKg, ceilingParams });
    const surfaceFit = fitSurfaceCostMultipliersFromIntensity(library);
    if (surfaceFit && surfaceFit.runCount >= MIN_SURFACE_FIT_RUNS) {
      callbacks.onApplySurfaceCostMultipliers(surfaceFit.surfaceCostMultipliers);
    }

    // HR-to-power calibration: pools (HR, power) points across the same
    // races, restricted internally to each race's own early/low-drift
    // window, blended with the athlete's own lab-measured LT1 (+fat-ox)
    // anchor points when available, and LOCKED exactly through the
    // athlete's own lab-measured LT2 pace+HR when available (see
    // fitHrToPowerCalibrationAcrossRaces's own doc: unlike the old
    // effortFraction fit's 25%-blend treatment for every anchor, locking
    // through LT2 specifically was checked leave-one-out against 3 real
    // races and improved all three simultaneously, with no tradeoff). The
    // race pool alone can end up entirely long-race-only for an athlete
    // with several ultras confirmed -- the near-LT2/short-race end of the
    // line would then be pure extrapolation from lower-power long-race
    // data with no anchor of its own; the LT2 lock fixes that end without
    // reopening the short-race-swamping bug the long-race restriction
    // exists to prevent.
    // Uses the RESOLVED lt1Fraction/lt2Fraction (honoring a pace-entered
    // threshold), not the raw formInputs fields directly -- those stay at
    // their default whenever the athlete entered LT1/LT2 as pace instead of
    // a fraction, which would silently anchor the wrong point.
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    const thresholdAnchors = buildThresholdPowerAnchorPoints(
      {
        lt1Fraction,
        lt2Fraction,
        lt1HeartRateBpm: formInputs.lt1HeartRateBpm,
        lt2HeartRateBpm: formInputs.lt2HeartRateBpm,
        fatOxPoints: formInputs.fatOxPoints,
        walkMaxMs: formInputs.walkMaxMs,
      },
      safeFit.ceilingParams,
    );
    const maxAerobic = maxAerobicPower(0, safeFit.ceilingParams);
    const lt2Anchor =
      formInputs.lt2HeartRateBpm !== null && maxAerobic > 0
        ? { hr: formInputs.lt2HeartRateBpm, powerWPerKg: lt2Fraction * maxAerobic }
        : undefined;
    // Auto-apply is gated on rSquared -- a low rSquared is a legitimate
    // result (HR may just not track this athlete's power well), not a
    // reason to lower the bar until it passes.
    const hrCalibrationFit = fitHrToPowerCalibrationAcrossRaces(races, safeFit.ceilingParams, {
      raceDates,
      halfLifeDays,
      thresholdAnchors,
      lockThroughLt2: lt2Anchor,
    });
    if (hrCalibrationFit && hrCalibrationFit.rSquared >= MIN_HR_CALIBRATION_R_SQUARED) {
      callbacks.onApplyHrCalibration(hrCalibrationFit.slope, hrCalibrationFit.intercept);
    }

    // Pacing-margin curve: needs its OWN HR calibration reading, not
    // necessarily hrCalibrationFit above -- reuses it when available, but
    // falls back to the lab-threshold-only calibration (no race data at
    // all, or too little to clear MIN_FIT_POINTS even before blending) so
    // this can still run for someone whose race pool can't support a fit
    // by itself.
    const marginCalibration =
      hrCalibrationFit ??
      fitHrToPowerCalibrationFromThresholds(
        {
          lt1Fraction,
          lt2Fraction,
          lt1HeartRateBpm: formInputs.lt1HeartRateBpm,
          lt2HeartRateBpm: formInputs.lt2HeartRateBpm,
          fatOxPoints: formInputs.fatOxPoints,
          walkMaxMs: formInputs.walkMaxMs,
        },
        safeFit.ceilingParams,
      );
    const marginFit = marginCalibration
      ? fitPacingMarginAcrossRaces(confirmedRaceTrendPoints, confirmedRaceNames, marginCalibration, safeFit.ceilingParams)
      : null;
    if (marginFit) callbacks.onApplyPacingMargin(marginFit);

    // Auto-apply once fitTauFInfWithSupportGate picks a well-supported,
    // internally-consistent (fInf, tau) pair. Deliberately NOT applying
    // tauFit/fInfFit independently: they're two different searches (one
    // holds fInf fixed, the other floats it), so a tauMin from one paired
    // with an fInf from the other is a combination neither fit produced.
    if (safeFit.tier === "joint") {
      callbacks.onApplyTau(safeFit.ceilingParams.tauMin ?? formInputs.tauMin);
      callbacks.onApplyFInf(safeFit.ceilingParams.fInf ?? formInputs.fInf);
    } else if (safeFit.tier === "tauOnly") {
      callbacks.onApplyTau(safeFit.ceilingParams.tauMin ?? formInputs.tauMin);
    }
    callbacks.onRacesFitted?.(races, raceDates);

    // Auto-estimate the tau range right after the fit, using the races
    // computed just above directly -- part of the same atomic operation,
    // not a separate manual step.
    const tauCI = await bootstrapTauConfidenceInterval(races, raceDates, ceilingParams);

    setStatus({
      running: false,
      result: {
        fitResult: safeFit.tauFit,
        fInfFitResult: safeFit.fInfFit,
        safeFitTier: safeFit.tier,
        surfaceFit,
        hrCalibrationFit,
        marginFit,
        transitGapCount: detectedTransitGaps,
        excludedForDurationCount: excludedForDuration,
        races,
        raceDates,
        tauCI: tauCI ?? "insufficient",
      },
      error: null,
    });
  } catch (err) {
    setStatus({ running: false, result: null, error: err instanceof Error ? err.message : "Fit failed." });
  }
}
