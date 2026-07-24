import { useCallback, useEffect, useMemo, useState } from "react";
import type { GpxPoint, PipelineResult } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  fitTauFInfWithSupportGate,
  fitUnpavedCostMultiplierAcrossRaces,
  MIN_INFORMATIVE_RACES,
  suggestFitImprovements,
  type EffortTrendPoint,
  type FInfTauFitResult,
  type FinishTimeTrainingRace,
  type MultiRaceTauFitResult,
  type MultiRaceUnpavedCostMultiplierResult,
  type SafeFitResult,
  type TauConfidenceInterval,
} from "../model/pacingFit";
import { DURABILITY_MIN_DURATION_S, suggestRunsForFit } from "../model/suggestRuns";
import { dedupeStoredRuns } from "../model/dedupeRuns";
import { attachSurfaceData } from "../model/surfaceExposure";
import { splitAtTransitGaps } from "../gpx/transitGap";
import {
  fitHrToEffortCalibrationAcrossRaces,
  fitHrToEffortCalibrationFromThresholds,
  predictHeartRateFromEffortFraction,
  type HrEffortCalibration,
} from "../model/hrCalibration";
import { sustainableFraction } from "../model/ceiling";
import { filterRunsSinceDate, shouldFetchNextBackfillPage, toStoredRunSummaryInput, type BackfillPage } from "../model/stravaBackfill";
import { computeTauDiagnostic, type RaceDiagnosticPoint } from "../model/tauDiagnostic";
import { buildRaceDiagnosticPoint } from "../model/raceDiagnosticPoint";
import {
  buildWithinRaceDiagnosticPoint,
  computeWithinRaceDescentDiagnostic,
  type WithinRaceDiagnosticPoint,
} from "../model/withinRaceDescentDiagnostic";
import { estimateVo2MaxFromRun } from "../model/vo2MaxEstimate";
import {
  addStoredRun,
  clearStoredRuns,
  deleteStoredRun,
  listStoredRuns,
  setStoredRunPoints,
  setStoredRunSurfaceEdges,
  upsertStoredRunSummary,
  type StoredRun,
} from "../storage/runLibrary";
import { resolveCeilingParams, resolveGlycogenStoreG, resolveLt1Lt2Fractions, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { fetchStravaActivity } from "./stravaClient";
import { fetchSurfaceEdges } from "./surfaceLookup";
import { useStravaSession } from "./useStravaSession";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
  onApplyFInf: (fInf: number) => void;
  onApplyUnpavedCostMultiplier: (unpavedCostMultiplier: number) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
  /** Reports the races/raceDates behind the just-completed fit up to the
   * parent -- lets the Results tab's finish-time-range feature reuse the
   * exact same training data without this panel needing to know anything
   * about Planning mode's course or the solver. */
  onRacesFitted?: (races: EffortTrendPoint[][], raceDates: (Date | null)[]) => void;
}

const BACKFILL_MAX_PAGES = 50;
const BACKFILL_PER_PAGE = 100;
const BACKFILL_PAGE_DELAY_MS = 300;

const DEFAULT_HALF_LIFE_DAYS = 75;
/** Only the strongest few estimates are shown -- see vo2MaxEstimates below
 * for why sorting by estimate descending is itself the intensity filter. */
const MAX_VO2MAX_ESTIMATES_SHOWN = 3;

/** A starting heuristic, not a tuned optimum -- at least half the variance
 * in this athlete's effort explained by HR alone before auto-applying the
 * HR-effort calibration. Below this, HR just isn't a reliable enough proxy
 * to trust automatically (still shown, and still manually applicable). */
const MIN_HR_CALIBRATION_R_SQUARED = 0.5;

function oneYearAgoDateInput(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Which values `fitTauFInfWithSupportGate` actually applied, if any -- the
 * tau-only fit and the joint fInf/tau fit are two independently-run,
 * methodologically different searches (one holds fInf fixed, the other
 * floats it), so their tauMin values are not interchangeable. Auto-applying
 * each fit's own output independently (the original bug here) could land on
 * a tauMin from one fit paired with an fInf from the other -- a combination
 * neither fit actually endorses, and one that can badly understate fade
 * (e.g. a barely-informative tau-only fit landing on a very large tau,
 * applied alongside a well-supported but much-lower-tau joint fInf value).
 * `fitTauFInfWithSupportGate` picks ONE coherent pair (joint fit if it's
 * well-supported, else the tau-only fit alone, else neither) -- this state
 * records which tier won, purely to drive the "applied automatically" copy
 * below; the two fit objects themselves are still shown in full for
 * diagnostics regardless of which one was actually applied. */

/** A run's own calendar date, for recency-weighting the multi-race fit --
 * Strava summaries carry it directly; GPX-derived runs (manual upload, or a
 * Strava run whose points have already been fetched) fall back to the
 * first point's own timestamp. Null if neither is available. */
function runDate(run: StoredRun): Date | null {
  if (run.date) return new Date(run.date);
  const firstPointTime = run.points?.[0]?.time;
  return firstPointTime ?? null;
}

/** A watch left running across a train/bus/car leg can hide a transit hop
 * inside an otherwise-real run (see gpx/transitGap.ts) -- fed straight into
 * a fit, that shows up as impossible pace and can badly distort tau/fInf
 * (found via a real 2025-10-19 activity: a ~56km "run" that was actually two
 * genuine ~10-15km running legs either side of two train rides). Splits at
 * any detected gap and processes each leg as its own course. Below
 * MIN_LEG_DISTANCE_KM only applies when a split actually happened -- an
 * unsplit run is used regardless of its own length, unchanged from prior
 * behavior, since a short *recorded* run isn't the problem this guards
 * against. */
const MIN_LEG_DISTANCE_KM = 5;

function courseLegsForRun(run: StoredRun): { course: PipelineResult; label: string }[] {
  if (run.points === null) return [];
  const pointLegs = splitAtTransitGaps(run.points);
  const labeled = pointLegs.map((points, i) => ({
    course: runPipeline(points),
    label: pointLegs.length > 1 ? `${run.name} (leg ${i + 1})` : run.name,
  }));
  if (pointLegs.length === 1) return labeled;
  return labeled.filter((l) => l.course.totalDistance3D / 1000 >= MIN_LEG_DISTANCE_KM);
}

export function RunLibraryPanel({
  formInputs,
  onApplyTau,
  onApplyFInf,
  onApplyUnpavedCostMultiplier,
  onApplyHrCalibration,
  onAddVo2MaxEntry,
  onRacesFitted,
}: RunLibraryPanelProps) {
  const { connected: stravaConnected } = useStravaSession();
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<MultiRaceTauFitResult | null>(null);
  const [fInfFitResult, setFInfFitResult] = useState<FInfTauFitResult | null>(null);
  const [unpavedCostMultiplierFitResult, setUnpavedCostMultiplierFitResult] = useState<MultiRaceUnpavedCostMultiplierResult | null>(
    null,
  );
  const [hrCalibrationFitResult, setHrCalibrationFitResult] = useState<HrEffortCalibration | null>(null);
  const [safeFitTier, setSafeFitTier] = useState<SafeFitResult["tier"] | null>(null);
  const [fitRan, setFitRan] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [transitGapCount, setTransitGapCount] = useState(0);
  const [excludedForDurationCount, setExcludedForDurationCount] = useState(0);
  // Kept locally (not just forwarded via onRacesFitted) so the tau
  // confidence-interval button below can reuse the exact same training
  // data without needing a Planning course or the parent's help.
  const [lastFittedRaces, setLastFittedRaces] = useState<{ races: EffortTrendPoint[][]; raceDates: (Date | null)[] } | null>(
    null,
  );
  const [tauCI, setTauCI] = useState<TauConfidenceInterval | "insufficient" | null>(null);
  const [computingTauCI, setComputingTauCI] = useState(false);
  const [halfLifeDays, setHalfLifeDays] = useState(DEFAULT_HALF_LIFE_DAYS);

  const [backfillFrom, setBackfillFrom] = useState(oneYearAgoDateInput);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);

  const [fetchingSuggestions, setFetchingSuggestions] = useState(false);

  const refresh = useCallback(() => {
    listStoredRuns().then(setRuns).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Catches the same activity stored under two different ids -- e.g. a
  // manual GPX upload (random id) and a later Strava backfill of the same
  // run (stable "strava:<id>"), which the storage layer's own upsert-by-id
  // dedup can't unify since they don't share a key. Everything below reads
  // from `dedupedRuns`, not `runs`, so a duplicate can't silently double-
  // count in the run list, a fit, the suggestions, or the diagnostic.
  const { kept: dedupedRuns, duplicateGroups } = useMemo(() => dedupeStoredRuns(runs), [runs]);

  const [removingDuplicates, setRemovingDuplicates] = useState(false);
  const removeDuplicates = async () => {
    setRemovingDuplicates(true);
    setError(null);
    try {
      for (const group of duplicateGroups) {
        for (const redundant of group.slice(1)) {
          await deleteStoredRun(redundant.id);
        }
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove duplicates.");
    } finally {
      setRemovingDuplicates(false);
    }
  };

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const text = await file.text();
        const points = parseGpx(text);
        if (points.length === 0) {
          setError("No track points found in this GPX file.");
          return;
        }
        await addStoredRun(file.name, points);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add this run.");
      }
    },
    [refresh],
  );

  const [clearing, setClearing] = useState(false);
  const clearAll = async () => {
    if (!window.confirm("Delete every stored run? This clears the whole local run library and can't be undone.")) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      await clearStoredRuns();
      setFitResult(null);
      setFInfFitResult(null);
      setUnpavedCostMultiplierFitResult(null);
      setHrCalibrationFitResult(null);
      setTransitGapCount(0);
      setExcludedForDurationCount(0);
      setFitRan(false);
      setDeselectedSuggestionIds(new Set());
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear the run library.");
    } finally {
      setClearing(false);
    }
  };

  const runBackfill = useCallback(async () => {
    setBackfilling(true);
    setError(null);
    const targetStartDate = new Date(backfillFrom);
    let page = 1;
    let imported = 0;
    try {
      for (;;) {
        setBackfillProgress(`Fetching page ${page}…`);
        const res = await fetch(`/api/strava/activities?page=${page}&per_page=${BACKFILL_PER_PAGE}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Backfill failed.");
        const pageResult = body as BackfillPage;

        for (const run of filterRunsSinceDate(pageResult.runs, targetStartDate)) {
          await upsertStoredRunSummary(toStoredRunSummaryInput(run));
          imported++;
        }

        if (!shouldFetchNextBackfillPage(pageResult, page, targetStartDate, BACKFILL_MAX_PAGES)) break;
        page++;
        await new Promise((r) => setTimeout(r, BACKFILL_PAGE_DELAY_MS));
      }
      setBackfillProgress(`Imported ${imported} run${imported === 1 ? "" : "s"} since ${backfillFrom}.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed.");
    } finally {
      setBackfilling(false);
    }
  }, [backfillFrom, refresh]);

  const ceilingParams = resolveCeilingParams(formInputs);

  // Lab-derived HR calibration -- from the athlete's own entered LT1/LT2
  // heart rate and (optionally) fat-ox-curve heart rate, not from any
  // imported training runs. Needs no fitting/import step, so this is
  // computed eagerly from formInputs alone; the training-history calibration
  // below still requires runs to have been fitted.
  const thresholdHrCalibrationFitResult = useMemo(() => {
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    return fitHrToEffortCalibrationFromThresholds(
      {
        lt1Fraction,
        lt2Fraction,
        lt1HeartRateBpm: formInputs.lt1HeartRateBpm,
        lt2HeartRateBpm: formInputs.lt2HeartRateBpm,
        fatOxPoints: formInputs.fatOxPoints,
        walkMaxMs: formInputs.walkMaxMs,
      },
      ceilingParams,
    );
  }, [
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.lt1HeartRateBpm,
    formInputs.lt2HeartRateBpm,
    formInputs.fatOxPoints,
    formInputs.walkMaxMs,
    formInputs.vo2MaxHistory,
    ceilingParams,
  ]);

  // PLAN.md §12 stage 4 / §13: does descent load (or generic intensity)
  // actually predict this athlete's own tau? Only races with full points
  // already fetched are included -- no new Strava calls triggered just to
  // populate a diagnostic. Races whose own single-race fit hit a search
  // boundary are excluded too (an unreliable estimate would just add noise).
  const tauDiagnostic = useMemo(() => {
    const diagnosticCeilingParams = resolveCeilingParams(formInputs);
    const points: RaceDiagnosticPoint[] = [];
    for (const run of dedupedRuns) {
      for (const { course, label } of courseLegsForRun(run)) {
        const point = buildRaceDiagnosticPoint(label, course, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams: diagnosticCeilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH },
          glycogenStoreG: resolveGlycogenStoreG(formInputs),
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        if (point) points.push(point);
      }
    }
    return computeTauDiagnostic(points);
  }, [dedupedRuns, formInputs]);

  // Within-race redesign of the descent diagnostic above: eccentric-loading
  // damage from a fast downhill should show up as degraded fade in whatever
  // comes *after* it, not smeared into a whole-race average -- few real
  // races have the ideal shape to test that via a whole-race comparison, so
  // this compares each race's own late-window behavior to its own early-
  // window descent instead. See withinRaceDescentDiagnostic.ts.
  const withinRaceDiagnostic = useMemo(() => {
    const diagnosticCeilingParams = resolveCeilingParams(formInputs);
    const points: WithinRaceDiagnosticPoint[] = [];
    for (const run of dedupedRuns) {
      for (const { course, label } of courseLegsForRun(run)) {
        const point = buildWithinRaceDiagnosticPoint(label, course, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams: diagnosticCeilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH },
          glycogenStoreG: resolveGlycogenStoreG(formInputs),
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        if (point) points.push(point);
      }
    }
    return computeWithinRaceDescentDiagnostic(points);
  }, [dedupedRuns, formInputs]);

  // PLAN.md §12: candidate VO2max estimates from already-fetched runs whose
  // duration falls in the near-maximal-effort window vo2MaxEstimate.ts can
  // use. Surfaced for the user to review and add, not auto-applied -- GPS
  // data alone can't confirm a run was actually paced near-maximally. An
  // easy run in this duration window can only *underestimate* (low observed
  // power -> low effort fraction -> low estimate); a genuine hard effort
  // recovers something close to the true value -- so sorting by estimate
  // descending and showing only the top few naturally surfaces the runs
  // most likely to have actually been run near-maximally, without needing a
  // separate intensity signal.
  const vo2MaxEstimates = useMemo(() => {
    const estimateCeilingParams = resolveCeilingParams(formInputs);
    const results: { run: StoredRun; estimateMlPerKgPerMin: number }[] = [];
    for (const run of dedupedRuns) {
      if (run.points === null) continue;
      const course = runPipeline(run.points);
      if (!course.hasTimestamps) continue;
      const analysis = analyzeRun(course.segments, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams: estimateCeilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      });
      const estimateMlPerKgPerMin = estimateVo2MaxFromRun(analysis, estimateCeilingParams);
      if (estimateMlPerKgPerMin === null) continue;
      results.push({ run, estimateMlPerKgPerMin });
    }
    return results.sort((a, b) => b.estimateMlPerKgPerMin - a.estimateMlPerKgPerMin).slice(0, MAX_VO2MAX_ESTIMATES_SHOWN);
  }, [dedupedRuns, formInputs]);

  const [addedVo2MaxRunIds, setAddedVo2MaxRunIds] = useState<Set<string>>(new Set());
  const addVo2MaxEstimate = (run: StoredRun, estimateMlPerKgPerMin: number) => {
    const date = runDate(run)?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    onAddVo2MaxEntry({ date, value: Math.round(estimateMlPerKgPerMin), source: "race" });
    setAddedVo2MaxRunIds((prev) => new Set(prev).add(run.id));
  };

  /** Fetches and persists full points for a summary-only row; a no-op if
   * they're already present. */
  const ensurePoints = async (run: StoredRun): Promise<GpxPoint[]> => {
    if (run.points !== null) return run.points;
    if (run.stravaId === undefined) return [];
    const { points } = await fetchStravaActivity(run.stravaId);
    await setStoredRunPoints(run.id, points);
    return points;
  };

  /** Fetches and caches Valhalla surface classification for a run; a no-op
   * if already cached. Returns null on any failure (or if this run has no
   * stable id to cache against) -- callers treat that exactly like "no
   * surface data available", never as an error to surface to the user (see
   * surfaceLookup.ts's own contract). A prior failed attempt is naturally
   * retried here too, since it's never cached as a permanent result. */
  const ensureSurfaceData = async (run: StoredRun, points: GpxPoint[]) => {
    if (run.surfaceEdges) return run.surfaceEdges;
    const edges = await fetchSurfaceEdges(points);
    if (edges && edges.length > 0) await setStoredRunSurfaceEdges(run.id, edges);
    return edges;
  };

  const runFit = async () => {
    // Automatic: every stored run with full GPS data already fetched is a
    // CANDIDATE for the fit, no manual curation needed -- runs still
    // summary-only (backfilled but not fetched) are simply left out until
    // fetched via the suggestions below or a direct import. Candidates
    // themselves are still filtered by duration below (DURABILITY_MIN_DURATION_S)
    // before actually feeding the pooled fits -- "no manual curation" means
    // the user never has to pick which runs count, not that every fetched
    // run automatically qualifies.
    const readyRuns = dedupedRuns.filter((r) => r.points !== null);

    setFitting(true);
    setError(null);
    try {
      // Solver "common" inputs (everything findSustainableTheta needs
      // besides segments/ceilingParams/unpavedCostMultiplier) for the
      // finish-time-fit multiplier search below.
      const commonMultiplierFitInputs = {
        bodyMassKg: formInputs.bodyMassKg,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      };
      const races: EffortTrendPoint[][] = [];
      const raceDates: (Date | null)[] = [];
      const finishTimeRaces: FinishTimeTrainingRace[] = [];
      let detectedTransitGaps = 0;
      let excludedForDuration = 0;
      for (const run of readyRuns) {
        const points = await ensurePoints(run);
        const pointLegs = splitAtTransitGaps(points);
        detectedTransitGaps += pointLegs.length - 1;
        // Cached surface edges were fetched (and are indexed by cumulative
        // distance) against the run's FULL point sequence -- they don't
        // decompose per leg, so a split run is treated as having no surface
        // data at all rather than risk misattributing edges from one leg
        // onto another's segments. Split runs are rare (most have no
        // transit gap at all, see transitGap.ts), so this only costs the
        // surface-cost-multiplier fit a little data in the uncommon case.
        const surfaceEdges = pointLegs.length === 1 ? await ensureSurfaceData(run, points) : null;
        for (const legPoints of pointLegs) {
          const course = runPipeline(legPoints);
          if (!course.hasTimestamps) continue;
          if (pointLegs.length > 1 && course.totalDistance3D / 1000 < MIN_LEG_DISTANCE_KM) continue;
          const segments = surfaceEdges ? attachSurfaceData(course.segments, surfaceEdges) : course.segments;
          // Deliberately NOT passing unpavedCostMultiplier here -- this feeds
          // fitUnpavedCostMultiplierAcrossRaces below, which needs RAW,
          // uncorrected grossPowerWPerKg (it applies its own candidate
          // multiplier internally while searching). See AnalysisInputs'
          // own doc on why passing an already-applied multiplier here would
          // compound with the fit instead of being learned from it.
          const analysis = analyzeRun(segments, {
            bodyMassKg: formInputs.bodyMassKg,
            ceilingParams,
            fueling: { intakeGPerH: formInputs.intakeGPerH },
            glycogenStoreG: resolveGlycogenStoreG(formInputs),
            walkMaxMs: formInputs.walkMaxMs,
            altitudeAdjustment: formInputs.altitudeAdjustment,
          });
          // Below DURABILITY_MIN_DURATION_S, a run can't span a meaningful
          // fraction of any realistic tau -- pooling it in anyway doesn't
          // just fail to help (the "unresponsive" flag already tries to
          // catch that after the fact), it can actively distort the search:
          // enough near-flat short runs pooled alongside a handful of long
          // races can pull tau toward an implausibly small value that
          // trivially "fits" the short runs' near-zero slope without
          // reflecting real fatigue-decay behavior at all. suggestRuns.ts
          // already uses this same bar to decide which summary-only runs
          // are worth fetching for this fit -- applying it here too closes
          // the gap where an already-fetched short run (uploaded directly,
          // or fetched for some other reason) could still sneak into the
          // pool uncurated.
          if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) {
            excludedForDuration++;
            continue;
          }
          races.push(buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment));
          raceDates.push(pointLegs.length > 1 ? (legPoints[0]?.time ?? runDate(run)) : runDate(run));
          finishTimeRaces.push({ segments, actualFinishTimeS: analysis.totalMovingTimeS });
        }
      }
      setTransitGapCount(detectedTransitGaps);
      setExcludedForDurationCount(excludedForDuration);
      const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates, halfLifeDays });
      setFitResult(safeFit.tauFit);
      setFInfFitResult(safeFit.fInfFit);
      setSafeFitTier(safeFit.tier);

      // Unpaved cost multiplier is fit against the SAME (tau, fInf) this fit
      // just settled on, holding them fixed -- keeps this a one-more-axis
      // addition, not a simultaneous joint search this session's
      // investigation never validated. Fits directly against each training
      // race's own actual finish time via the real solver (not an effort-
      // fraction proxy -- an earlier version tried that and badly
      // underestimated the multiplier, see fitUnpavedCostMultiplierAcrossRaces'
      // own doc comment), so needs full segments + actual time, not just
      // trend points -- meaningfully more expensive than the tau/fInf fits
      // above. Auto-applies under the same support bar as the tau-only tier
      // (informative races, no boundary hit) -- there's no "joint"
      // equivalent to prefer instead, since this is the only fit for this
      // term.
      const multiplierFit = fitUnpavedCostMultiplierAcrossRaces(finishTimeRaces, safeFit.ceilingParams, commonMultiplierFitInputs, {
        raceDates,
        halfLifeDays,
      });
      setUnpavedCostMultiplierFitResult(multiplierFit);
      if (multiplierFit && multiplierFit.informativeRaceCount >= MIN_INFORMATIVE_RACES && !multiplierFit.hitSearchBoundary) {
        onApplyUnpavedCostMultiplier(multiplierFit.unpavedCostMultiplier);
      }

      // HR-to-effort calibration (PLAN.md §11 stage 3): pools (HR, effort)
      // points across the same races, restricted internally to each race's
      // own early/low-drift window. Cheap (no solver simulation needed,
      // unlike the multiplier fit above) -- operates on the same trend
      // points already built for tau/fInf. Auto-apply is gated on rSquared,
      // not just point count (already enforced inside the fit itself) --
      // a low rSquared is a legitimate result (HR may just not track this
      // athlete's effort well), not a reason to lower the bar until it
      // passes.
      const hrCalibrationFit = fitHrToEffortCalibrationAcrossRaces(races, safeFit.ceilingParams, { raceDates, halfLifeDays });
      setHrCalibrationFitResult(hrCalibrationFit);
      if (hrCalibrationFit && hrCalibrationFit.rSquared >= MIN_HR_CALIBRATION_R_SQUARED) {
        onApplyHrCalibration(hrCalibrationFit.slope, hrCalibrationFit.intercept);
      }
      // Auto-apply once fitTauFInfWithSupportGate picks a well-supported,
      // internally-consistent (fInf, tau) pair -- so "select a date, click
      // to fit" is one step instead of fit-then-separately-click-apply.
      // Deliberately NOT applying tauFit/fInfFit independently here: they're
      // two different searches (one holds fInf fixed, the other floats it),
      // so a tauMin from one paired with an fInf from the other is a
      // combination neither fit actually produced. Manual Apply buttons
      // below still apply either fit's own value on its own if you want to
      // override this choice.
      // CeilingParams' fields are optional in the type (defaults apply
      // elsewhere), but resolveCeilingParams always fills tauMin/fInf from
      // FormInputs' own non-optional fields -- the `?? formInputs...`
      // fallbacks below are for TypeScript, not because the fit could
      // actually omit them for a tier that claims to have applied them.
      if (safeFit.tier === "joint") {
        onApplyTau(safeFit.ceilingParams.tauMin ?? formInputs.tauMin);
        onApplyFInf(safeFit.ceilingParams.fInf ?? formInputs.fInf);
      } else if (safeFit.tier === "tauOnly") {
        onApplyTau(safeFit.ceilingParams.tauMin ?? formInputs.tauMin);
      }
      setFitRan(true);
      setLastFittedRaces({ races, raceDates });
      setTauCI(null); // stale relative to the new fit above -- re-estimate on demand
      onRacesFitted?.(races, raceDates);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fit failed.");
    } finally {
      setFitting(false);
    }
  };

  /** On-demand, not a live recompute -- ~100 sequential tau refits is too
   * slow to run on every render. Reuses the exact races/raceDates from the
   * fit above, so this needs no target course or solver at all. */
  const handleEstimateTauCI = async () => {
    if (!lastFittedRaces) return;
    setComputingTauCI(true);
    setTauCI(null);
    try {
      const ci = await bootstrapTauConfidenceInterval(lastFittedRaces.races, lastFittedRaces.raceDates, ceilingParams);
      setTauCI(ci ?? "insufficient");
    } finally {
      setComputingTauCI(false);
    }
  };

  const fitImprovementSuggestions = useMemo(
    () => suggestFitImprovements(fitResult, fInfFitResult, tauCI === "insufficient" ? null : tauCI),
    [fitResult, fInfFitResult, tauCI],
  );

  const suggestions = useMemo(() => suggestRunsForFit(dedupedRuns), [dedupedRuns]);
  // A run can appear in more than one bucket (e.g. the single longest run is
  // both a durability and a duration-spread candidate) -- dedupe by id so it
  // isn't counted or fetched twice.
  const suggestedRuns = useMemo(() => {
    const byId = new Map([...suggestions.vo2max, ...suggestions.durability, ...suggestions.durationSpread].map((r) => [r.id, r]));
    return [...byId.values()];
  }, [suggestions]);
  const pendingSuggestedRuns = useMemo(() => suggestedRuns.filter((r) => r.points === null), [suggestedRuns]);

  // Auto-fetches full data for every suggested run -- no manual approve/
  // exclude step. Only re-runs when the pending set actually changes (which
  // only happens once refresh() below updates `runs` post-fetch), so this
  // settles once every suggestion has full data, rather than looping.
  useEffect(() => {
    if (pendingSuggestedRuns.length === 0) return;
    let cancelled = false;
    (async () => {
      setFetchingSuggestions(true);
      setError(null);
      try {
        for (const run of pendingSuggestedRuns) {
          if (cancelled) return;
          await ensurePoints(run);
        }
        if (!cancelled) refresh();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch suggested runs.");
      } finally {
        if (!cancelled) setFetchingSuggestions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSuggestedRuns]);

  const readyCount = dedupedRuns.filter((r) => r.points !== null).length;

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Run library</h3>
        {dedupedRuns.length > 0 && (
          <button type="button" className="chart__reset-zoom" onClick={() => void clearAll()} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear all stored runs"}
          </button>
        )}
      </div>
      <p className="field-group-help">
        Store past runs here and fit one shared fade time constant (tau) across several of them at once, instead of
        just this course's recording. Pooling races is mainly about robustness -- one tau has to flatten every
        race's own effort trend simultaneously, not just one run's idiosyncrasies. It doesn't separately identify f0
        or fInf: that needs races spanning a much wider range of durations than a typical library, plus an anchor on
        the ceiling's absolute level that this fit doesn't have. Every stored run with full GPS data and a recorded
        timestamp is considered automatically -- no manual curation needed -- but runs under{" "}
        {(DURABILITY_MIN_DURATION_S / 60).toFixed(0)} minutes are left out of the fit itself (too short to say
        anything real about fatigue decay at ultra scale; see the note below if any were).
      </p>

      <label className="gpx-upload__control">
        <span>Add a run</span>
        <input
          type="file"
          accept=".gpx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
      <StravaImport onImport={(points, name, stravaId) => addStoredRun(name, points, stravaId).then(refresh)} />

      {stravaConnected && (
        <>
          <div className="strava-import__link-row">
            <span>Backfill runs since</span>
            <input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} />
            <button type="button" className="fatox-add" onClick={() => void runBackfill()} disabled={backfilling}>
              {backfilling ? "Backfilling…" : "Backfill"}
            </button>
          </div>
          <p className="field-group-help">
            Pulls a lightweight summary (distance, duration, elevation, avg heart rate/power) for every run in this
            range -- no full GPS data yet, so this stays cheap regardless of how far back you go. Full data for a
            specific run is only fetched once you actually select it below.
          </p>
          {backfillProgress && <p className="field-group-note">{backfillProgress}</p>}
        </>
      )}

      {error && <p className="gpx-upload__error">{error}</p>}

      {fetchingSuggestions && (
        <p className="field-group-note">Fetching full data for recommended runs (hard efforts, longest runs, duration spread)…</p>
      )}

      {duplicateGroups.length > 0 && (
        <p className="warning">
          Found {duplicateGroups.length} run{duplicateGroups.length === 1 ? "" : "s"} stored twice under different
          ids (e.g. uploaded manually and later pulled in again via Strava backfill) -- excluded from the list,
          fit, suggestions, and diagnostic below, but still sitting in storage.{" "}
          <button type="button" className="fatox-add" onClick={() => void removeDuplicates()} disabled={removingDuplicates}>
            {removingDuplicates ? "Removing…" : `Remove ${duplicateGroups.length} duplicate entr${duplicateGroups.length === 1 ? "y" : "ies"}`}
          </button>
        </p>
      )}

      {dedupedRuns.length === 0 && <p className="placeholder">No runs stored yet.</p>}

      {dedupedRuns.length > 0 && (
        <>
          <div className="strava-import__range-row">
            <span>Recency half-life</span>
            <input
              type="number"
              min={1}
              value={halfLifeDays}
              onChange={(e) => setHalfLifeDays(Number(e.target.value))}
            />
            <span>days -- older runs count for less</span>
          </div>
          <button type="button" className="fatox-add" onClick={() => void runFit()} disabled={readyCount === 0 || fitting}>
            {fitting ? "Fitting…" : `Fit tau from ${readyCount} downloaded run${readyCount === 1 ? "" : "s"}`}
          </button>
        </>
      )}

      {fitRan && transitGapCount > 0 && (
        <p className="field-group-note">
          Detected and cropped out {transitGapCount} transit gap{transitGapCount === 1 ? "" : "s"} (GPS jumps far
          faster than running is possible, typically a watch left running across a train/bus/car leg) -- the genuine
          running before and after each gap was still used, just as separate legs.
        </p>
      )}

      {fitRan && excludedForDurationCount > 0 && (
        <p className="field-group-note">
          Left out {excludedForDurationCount} run{excludedForDurationCount === 1 ? "" : "s"} under{" "}
          {(DURABILITY_MIN_DURATION_S / 60).toFixed(0)} minutes -- too short to say anything real about fatigue-decay
          over an ultra-scale race, and pooling them in anyway can pull tau toward an implausibly small value rather
          than just having no effect.
        </p>
      )}

      {fitRan && !fitResult && (
        <p className="warning">
          Not enough moving time across your stored runs to fit a trend -- add longer recordings, or more of them.
        </p>
      )}

      {fitResult && (
        <>
          <p className="field-group-note">
            Best-fit tau across {fitResult.perRace.length} run{fitResult.perRace.length === 1 ? "" : "s"}: {fitResult.tauMin} min.
          </p>
          {fitResult.informativeRaceCount < MIN_INFORMATIVE_RACES && (
            <p className="warning">
              Only {fitResult.informativeRaceCount} of {fitResult.perRace.length} runs actually constrained this fit
              (too short or too long relative to the fitted tau for their modeled ceiling to move) -- with fewer than{" "}
              {MIN_INFORMATIVE_RACES}, this isn't really a pooled result, it's effectively one run's own pacing
              labeled as a fit across many. Treat this tau with real caution -- more stored runs of a genuinely
              different duration would help.
            </p>
          )}
          <button type="button" className="fatox-add" onClick={() => onApplyTau(fitResult.tauMin)}>
            Apply tau = {fitResult.tauMin} min
          </button>
          <p className="field-group-note">
            {safeFitTier === "tauOnly"
              ? "Applied automatically -- this fit had enough informative races, stayed within its search range, and the joint fInf/tau fit below wasn't well-supported enough to prefer instead."
              : safeFitTier === "joint"
                ? "Not applied automatically from here -- the joint fInf/tau fit below was better-supported and was applied instead (as a matched fInf+tau pair, not mixed with this fit's own tau)."
                : "Not applied automatically -- see the notes above; you can still apply it manually if you trust it."}
          </p>
          {fitResult.hitSearchBoundary && (
            <p className="field-group-note">
              This landed at the {fitResult.hitSearchBoundary} edge of the search range -- treat it as a bound, not a
              precise value. The true tau may be even{" "}
              {fitResult.hitSearchBoundary === "upper" ? "larger (a slower fade)" : "smaller (a faster fade)"}.
            </p>
          )}

          <button type="button" onClick={handleEstimateTauCI} disabled={computingTauCI}>
            {computingTauCI ? "Estimating…" : "Estimate tau confidence interval"}
          </button>
          <p className="field-group-help">
            A bootstrap confidence interval on tau itself: how much tau would vary if fit on a slightly different
            sample of your own runs. Not a real-world guarantee -- it doesn't account for physiological changes over
            time, just how well this specific set of runs pins tau down.
          </p>
          {tauCI === "insufficient" && (
            <p className="warning">
              Not enough informative runs to estimate a confidence interval -- the same support bar the tau fit above
              needed.
            </p>
          )}
          {tauCI && tauCI !== "insufficient" && (
            <p className="field-group-note">
              Tau confidence interval: {tauCI.lowTauMin.toFixed(0)}–{tauCI.highTauMin.toFixed(0)} min (median{" "}
              {tauCI.medianTauMin.toFixed(0)}), point estimate {tauCI.pointEstimateTauMin.toFixed(0)} min. Based on{" "}
              {tauCI.sampleCount} usable bootstrap resamples ({tauCI.skippedCount} skipped for not clearing the same
              support bar the fit above needed).
            </p>
          )}
        </>
      )}

      {fInfFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Experimental: joint fInf/tau fit (PLAN.md §11)</p>
          <p className="field-group-help">
            Fits fInf and tau together from the same runs above, holding VO2max and f0 fixed -- fixing f0 is
            what makes this well-posed rather than an unbounded search (verified with a synthetic recovery test, not
            just assumed). This does <strong>not</strong> independently verify VO2max or f0: fInf comes out relative
            to whatever those currently are, and absorbs error in both. Treat this as "the fit is runnable," not "fInf
            is now a trustworthy, independently-measured number."
          </p>
          <p className={fInfFitResult.durationDiversityRatio < 2 ? "warning" : "field-group-note"}>
            Duration range across these races: {fInfFitResult.durationDiversityRatio.toFixed(1)}x (longest ÷
            shortest).{" "}
            {fInfFitResult.durationDiversityRatio < 2
              ? "PLAN.md recommends at least ~2x for fInf to be separable from tau -- treat this result as a rough guess, not a firm number."
              : "At or above the ~2x PLAN.md recommends for separating fInf from tau."}
          </p>
          <p className="field-group-note">
            Best fit: fInf {fInfFitResult.fInf.toFixed(2)}, tau {fInfFitResult.tauMin} min, across{" "}
            {fInfFitResult.perRace.length} run{fInfFitResult.perRace.length === 1 ? "" : "s"}.
          </p>
          {fInfFitResult.informativeRaceCount < MIN_INFORMATIVE_RACES && (
            <p className="warning">
              Only {fInfFitResult.informativeRaceCount} of {fInfFitResult.perRace.length} runs actually constrained
              this fit -- with fewer than {MIN_INFORMATIVE_RACES}, "fInf {fInfFitResult.fInf.toFixed(2)}, tau{" "}
              {fInfFitResult.tauMin}min" is really just one run's own pacing, not a genuine multi-race result. More
              stored runs of a different duration would help.
            </p>
          )}
          <button type="button" className="fatox-add" onClick={() => onApplyFInf(fInfFitResult.fInf)}>
            Apply fInf = {fInfFitResult.fInf.toFixed(2)}
          </button>
          <p className="field-group-note">
            {safeFitTier === "joint"
              ? "Applied automatically, together with tau from this same joint fit -- both applied as a matched pair, not independently."
              : "Not applied automatically -- see the notes above; you can still apply it manually if you trust it (note: doing so pairs it with whatever tau is currently applied, which this fit did not itself produce)."}
          </p>
          {(fInfFitResult.hitSearchBoundary.fInf || fInfFitResult.hitSearchBoundary.tau) && (
            <p className="field-group-note">
              Hit a search boundary on{" "}
              {[
                fInfFitResult.hitSearchBoundary.fInf && `fInf (${fInfFitResult.hitSearchBoundary.fInf})`,
                fInfFitResult.hitSearchBoundary.tau && `tau (${fInfFitResult.hitSearchBoundary.tau})`,
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              -- treat as a bound, not a precise value.
            </p>
          )}
        </div>
      )}

      {unpavedCostMultiplierFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Terrain surface cost</p>
          <p className="field-group-help">
            A flat cost multiplier applied while actually moving across unpaved/technical trail -- an instantaneous
            effect with no carryover to paved segments afterward, unlike a durability/fatigue term. Surface fetched
            via a public OpenStreetMap map-matching lookup per run (fails silently and just leaves a run out if that
            lookup doesn't succeed). Fit directly against each training run's own actual finish time via the real
            solver, not just an average-effort comparison -- a leave-one-out backtest showed this flat-cost model
            roughly halves the remaining prediction error on real races with meaningful unpaved terrain.
          </p>
          <p className="field-group-note">
            Best fit: {unpavedCostMultiplierFitResult.unpavedCostMultiplier.toFixed(2)}x cost (
            {((unpavedCostMultiplierFitResult.unpavedCostMultiplier - 1) * 100).toFixed(0)}% slower on unpaved
            terrain), across {unpavedCostMultiplierFitResult.perRace.length} run
            {unpavedCostMultiplierFitResult.perRace.length === 1 ? "" : "s"} with surface data.
          </p>
          {unpavedCostMultiplierFitResult.informativeRaceCount < MIN_INFORMATIVE_RACES && (
            <p className="warning">
              Only {unpavedCostMultiplierFitResult.informativeRaceCount} of {unpavedCostMultiplierFitResult.perRace.length}{" "}
              runs with surface data actually had any unpaved terrain to learn from -- with fewer than{" "}
              {MIN_INFORMATIVE_RACES}, treat this multiplier with real caution.
            </p>
          )}
          <button
            type="button"
            className="fatox-add"
            onClick={() => onApplyUnpavedCostMultiplier(unpavedCostMultiplierFitResult.unpavedCostMultiplier)}
          >
            Apply multiplier = {unpavedCostMultiplierFitResult.unpavedCostMultiplier.toFixed(2)}x
          </button>
          <p className="field-group-note">
            {unpavedCostMultiplierFitResult.informativeRaceCount >= MIN_INFORMATIVE_RACES && !unpavedCostMultiplierFitResult.hitSearchBoundary
              ? "Applied automatically -- enough informative runs, and stayed within its search range."
              : "Not applied automatically -- see the notes above; you can still apply it manually if you trust it."}
          </p>
          {unpavedCostMultiplierFitResult.hitSearchBoundary && (
            <p className="field-group-note">
              This landed at the {unpavedCostMultiplierFitResult.hitSearchBoundary} edge of the search range -- treat
              it as a bound, not a precise value.
            </p>
          )}
        </div>
      )}

      {hrCalibrationFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">HR-effort calibration -- from your training history (PLAN.md §11)</p>
          <p className="field-group-help">
            A per-athlete mapping from heart rate to effort fraction, fit from the early (roughly first 65%) portion
            of each race where cardiac drift is smallest -- HR climbing at constant true output from rising core
            temperature/dehydration, not increased intensity, typically 10-15bpm over a long aerobic effort and worse
            in heat. Doesn't feed pace/power-based predictions at all; it exists so a heart-rate reading can be
            converted to an effort estimate wherever that's useful (e.g. the Power &amp; HR chart in Analysis mode).
          </p>
          <p className="field-group-note">
            Best fit: effort fraction ≈ {hrCalibrationFitResult.intercept.toFixed(3)} +{" "}
            {hrCalibrationFitResult.slope.toFixed(4)} × heart rate, R² = {hrCalibrationFitResult.rSquared.toFixed(2)},
            from {hrCalibrationFitResult.pointCount} points across {hrCalibrationFitResult.raceCount} run
            {hrCalibrationFitResult.raceCount === 1 ? "" : "s"}.
          </p>
          {hrCalibrationFitResult.rSquared < MIN_HR_CALIBRATION_R_SQUARED && (
            <p className="warning">
              R² is below {MIN_HR_CALIBRATION_R_SQUARED.toFixed(1)} -- heart rate doesn't track this athlete's effort
              very reliably yet (or this is too little/noisy data). Not a bug: some athletes' HR just isn't a strong
              effort proxy. Treat this calibration with real caution, or gather more runs with HR data.
            </p>
          )}
          <button
            type="button"
            className="fatox-add"
            onClick={() => onApplyHrCalibration(hrCalibrationFitResult.slope, hrCalibrationFitResult.intercept)}
          >
            Apply calibration
          </button>
          <p className="field-group-note">
            {hrCalibrationFitResult.rSquared >= MIN_HR_CALIBRATION_R_SQUARED
              ? "Applied automatically -- R² cleared the bar for trusting HR as an effort proxy for this athlete."
              : "Not applied automatically -- see the note above; you can still apply it manually if you trust it."}
          </p>
        </div>
      )}

      {hrCalibrationFitResult &&
        (() => {
          const referenceCeilingFraction = sustainableFraction(0, ceilingParams);
          const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
          const labAnchors: { label: string; enteredHr: number; effortFraction: number }[] = [];
          if (formInputs.lt1HeartRateBpm !== null) {
            labAnchors.push({ label: "LT1", enteredHr: formInputs.lt1HeartRateBpm, effortFraction: lt1Fraction / referenceCeilingFraction });
          }
          if (formInputs.lt2HeartRateBpm !== null) {
            labAnchors.push({ label: "LT2", enteredHr: formInputs.lt2HeartRateBpm, effortFraction: lt2Fraction / referenceCeilingFraction });
          }
          if (labAnchors.length === 0) return null;
          return (
            <div className="run-library__experimental-fit">
              <p className="field-group-note">Derived vs. entered heart rate</p>
              <p className="field-group-help">
                What the training-history calibration above predicts at your own LT1/LT2 effort levels, compared
                against the heart rate you actually entered for them -- a direct check of whether your training data
                and your lab thresholds agree.
              </p>
              <ul className="run-library__fit-notes">
                {labAnchors.map((a) => {
                  const derivedHr = predictHeartRateFromEffortFraction(a.effortFraction, hrCalibrationFitResult);
                  const delta = derivedHr - a.enteredHr;
                  return (
                    <li key={a.label}>
                      {a.label}: derived {derivedHr.toFixed(0)}bpm from training history vs. entered {a.enteredHr}bpm
                      (Δ {delta >= 0 ? "+" : ""}
                      {delta.toFixed(0)}bpm)
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}

      {thresholdHrCalibrationFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">HR-effort calibration -- from your LT1/LT2/fat-ox thresholds</p>
          <p className="field-group-help">
            Same effort fraction ≈ intercept + slope × heart-rate mapping as above, but fit directly from your own
            lab-measured thresholds (LT1/LT2 heart rate, and any fat-ox curve points with heart rate entered above)
            instead of pooled training-run data -- no terrain noise, no warm-up transient, no race-duration decay
            confound, since these are controlled measurements rather than real-world GPS data.
          </p>
          <p className="field-group-note">
            Best fit: effort fraction ≈ {thresholdHrCalibrationFitResult.intercept.toFixed(3)} +{" "}
            {thresholdHrCalibrationFitResult.slope.toFixed(4)} × heart rate, from{" "}
            {thresholdHrCalibrationFitResult.pointCount} lab point
            {thresholdHrCalibrationFitResult.pointCount === 1 ? "" : "s"}
            {thresholdHrCalibrationFitResult.pointCount <= 2
              ? " (only 2 points -- the line passes through both exactly, so this isn't a fit with real slack in it)"
              : `, R² = ${thresholdHrCalibrationFitResult.rSquared.toFixed(2)}`}
            .
          </p>
          <button
            type="button"
            className="fatox-add"
            onClick={() => onApplyHrCalibration(thresholdHrCalibrationFitResult.slope, thresholdHrCalibrationFitResult.intercept)}
          >
            Apply calibration
          </button>
          <p className="field-group-note">
            Not applied automatically -- lab data is trustworthy but usually just a handful of points; compare it
            against your training-history calibration above before choosing one to apply.
          </p>
        </div>
      )}

      {fitImprovementSuggestions.length > 0 && (
        <div className="run-library__fit-improvements">
          <p className="field-group-note">What would improve this fit?</p>
          <ul className="run-library__fit-notes">
            {fitImprovementSuggestions.map((s, i) => (
              <li key={i} className={s.severity === "warning" ? "warning" : "field-group-note"}>
                {s.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {vo2MaxEstimates.length > 0 && (
        <div className="run-library__vo2max-estimates">
          <p className="field-group-note">Estimated VO2max from recent hard efforts</p>
          <p className="field-group-help">
            Derived from each run's own average effort relative to the current ceiling model (PLAN.md §12), among
            already-fetched runs long enough to trust as a genuine near-maximal effort (roughly 20-90 minutes). Only
            the {MAX_VO2MAX_ESTIMATES_SHOWN} highest estimates are shown, highest first: an easy run in this window
            can only <em>underestimate</em> VO2max, so the strongest readings are the ones most likely to reflect a
            real hard effort rather than a recovery jog that happens to be this long. Review before adding --
            accepted entries land in your VO2max history as a "race"-sourced measurement, weighted less than a lab
            test but more than a bare guess.
          </p>
          <div className="fatox-rows">
            {vo2MaxEstimates.map(({ run, estimateMlPerKgPerMin }) => {
              const added = addedVo2MaxRunIds.has(run.id);
              return (
                <div key={run.id} className="run-library-row">
                  <span className="run-library-row__label">
                    {run.name} &middot; est. VO2max {estimateMlPerKgPerMin.toFixed(1)} ml/kg/min
                  </span>
                  <button
                    type="button"
                    className="fatox-add"
                    onClick={() => addVo2MaxEstimate(run, estimateMlPerKgPerMin)}
                    disabled={added}
                  >
                    {added ? "Added" : "Add to history"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="run-library__diagnostic">
        <p className="field-group-note">Diagnostic: does descent (or descent covered fast) or intensity predict your own tau?</p>
        <p className="field-group-help">
          Cheap check before considering a model redesign (PLAN.md §12/§13): each already-fetched run's own
          single-race best-fit tau, average effort, descent per km, and two descent-<em>impact</em> variants per
          km -- weighting each descending stretch by how fast it was run (descent meters &times; speed, or
          &times; speed&sup2; for a kinetic-energy-proportional reading) instead of by elevation loss alone, on
          the theory that eccentric-loading damage tracks how fast you hit the downhills. The stage-5 hypothesis is
          that harder, more descent-loaded, or faster-descended runs fade <em>faster</em> -- a{" "}
          <strong>negative</strong> correlation (higher intensity/descent/impact going with a <em>smaller</em>{" "}
          tau), not just any relationship. Runs whose own fit hit a search-range boundary are excluded as unreliable.
          Average effort is computed against each run's <em>own</em> best-fit tau, not one shared default -- using one
          global tau for every run inflates the reading for anything much longer than that tau's own timescale (a
          ~30h race can otherwise misread as ~100% effort simply because the ceiling has already decayed to near-fInf
          long before the race is done), which would make short and long runs incomparable on this axis.
        </p>
        {tauDiagnostic.points.length < 3 ? (
          <p className="placeholder">
            Need at least 3 runs with full data already fetched and a reliable single-race tau fit -- currently{" "}
            {tauDiagnostic.points.length}.
          </p>
        ) : (
          <>
            <div className="fatox-rows">
              {tauDiagnostic.points.map((p, i) => (
                <div key={i} className="run-library-row">
                  <span className="run-library-row__label">
                    {p.label} &middot; tau {p.tauMin} min &middot; {(p.avgIntensity * 100).toFixed(0)}% avg effort
                    &middot; {p.descentPerKm.toFixed(0)} m/km descent &middot; {p.descentImpactPerKm.toFixed(0)}{" "}
                    impact/km &middot; {p.descentImpactSquaredPerKm.toFixed(0)} impact&sup2;/km
                  </span>
                </div>
              ))}
            </div>
            <p className="field-group-note">
              Correlation (tau vs. intensity):{" "}
              {tauDiagnostic.intensityCorrelation !== null ? tauDiagnostic.intensityCorrelation.toFixed(2) : "n/a"}
              {" · "}
              Correlation (tau vs. descent):{" "}
              {tauDiagnostic.descentCorrelation !== null ? tauDiagnostic.descentCorrelation.toFixed(2) : "n/a"}
              {" · "}
              Correlation (tau vs. descent impact):{" "}
              {tauDiagnostic.descentImpactCorrelation !== null
                ? tauDiagnostic.descentImpactCorrelation.toFixed(2)
                : "n/a"}
              {" · "}
              Correlation (tau vs. descent impact&sup2;):{" "}
              {tauDiagnostic.descentImpactSquaredCorrelation !== null
                ? tauDiagnostic.descentImpactSquaredCorrelation.toFixed(2)
                : "n/a"}
            </p>
            <p className="field-group-help">
              A meaningfully negative value (below roughly −0.5) on any of these supports building that
              signal into a fade term. Near zero or positive means this athlete's own data doesn't show the effect
              -- not a reason to build it yet. Watch both descent-impact variants against <em>intensity</em>, not
              against raw descent: both have speed baked directly into them, so they'll tend to beat raw descent
              for reasons that have nothing to do with descent -- a fast race scores high on impact and intensity
              together. The real test of whether descent-at-speed is its own effect is whether either impact
              variant explains tau any better than intensity alone already does, not whether it beats descent
              alone. Comparing the two impact variants against each other is also informative: if the squared
              version tracks tau meaningfully better than the linear one, that favors a kinetic-energy-style
              relationship over a linear one -- if they're about equally (un)correlated, the exponent isn't
              distinguishing anything with this library yet.
            </p>
          </>
        )}
      </div>

      <div className="run-library__diagnostic">
        <p className="field-group-note">Experimental: does early descent predict a worse-than-expected late fade?</p>
        <p className="field-group-help">
          A redesign of the diagnostic above: eccentric-loading damage from a fast downhill should show up as
          degraded fade in whatever comes <em>after</em> it, not smeared into a whole-race average -- few real
          races have the ideal shape (fast descent concentrated early, substantial distance remaining after) to
          test that via a whole-race comparison. This instead splits each race at its midpoint, sums descent in the
          first half, and computes the second half's own residual trend at the race's already-fitted tau -- near
          zero if a single clean fade shape explains the whole race, negative if the back half faded faster than
          that shape predicts. The hypothesis predicts a <strong>negative</strong> correlation (more early descent
          going with a worse-than-expected late residual). Works with any race that has some early descent -- it
          doesn't need a specially-shaped race, since the comparison is within each race, not between them. Races
          whose late half is under an hour are excluded -- not just too few points to fit, but too little time for
          a real muscular-fatigue effect to plausibly show up in at all (confirmed on real data: a couple of
          ~20-minute late windows swung wildly and dominated an otherwise-small sample).
        </p>
        {withinRaceDiagnostic.points.length < 3 ? (
          <p className="placeholder">
            Need at least 3 runs with full data already fetched, a reliable whole-race tau fit, and a late half of at
            least an hour -- currently {withinRaceDiagnostic.points.length}.
          </p>
        ) : (
          <>
            <div className="fatox-rows">
              {withinRaceDiagnostic.points.map((p, i) => (
                <div key={i} className="run-library-row">
                  <span className="run-library-row__label">
                    {p.label} &middot; late residual {p.lateResidualTrendPctPerHour >= 0 ? "+" : ""}
                    {p.lateResidualTrendPctPerHour.toFixed(1)}%/h &middot; {p.earlyDescentPerKm.toFixed(0)} m/km early
                    descent &middot; {p.earlyDescentImpactPerKm.toFixed(0)} early impact/km &middot;{" "}
                    {p.earlyDescentImpactSquaredPerKm.toFixed(0)} early impact&sup2;/km
                  </span>
                </div>
              ))}
            </div>
            <p className="field-group-note">
              Correlation (late residual vs. early descent):{" "}
              {withinRaceDiagnostic.lateResidualVsEarlyDescentCorrelation !== null
                ? withinRaceDiagnostic.lateResidualVsEarlyDescentCorrelation.toFixed(2)
                : "n/a"}
              {" · "}
              vs. early descent impact:{" "}
              {withinRaceDiagnostic.lateResidualVsEarlyDescentImpactCorrelation !== null
                ? withinRaceDiagnostic.lateResidualVsEarlyDescentImpactCorrelation.toFixed(2)
                : "n/a"}
              {" · "}
              vs. early descent impact&sup2;:{" "}
              {withinRaceDiagnostic.lateResidualVsEarlyDescentImpactSquaredCorrelation !== null
                ? withinRaceDiagnostic.lateResidualVsEarlyDescentImpactSquaredCorrelation.toFixed(2)
                : "n/a"}
            </p>
            <p className="field-group-help">
              Newer and less battle-tested than the whole-race diagnostic above -- treat any result here as a
              first read, not a settled one. The 50/50 early/late split is a fixed default, not tuned yet.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
