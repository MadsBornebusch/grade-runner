import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CourseSegment, GpxPoint, SurfaceCategory } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  fitSurfaceCostMultipliersFromIntensity,
  fitTauFInfWithSupportGate,
  MIN_INFORMATIVE_RACES,
  suggestFitImprovements,
  type EffortTrendPoint,
  type FInfTauFitResult,
  type MultiRaceTauFitResult,
  type SafeFitResult,
  type SurfaceCostMultiplierFitResult,
  type TauConfidenceInterval,
} from "../model/pacingFit";
import { buildSegmentLibrary } from "../model/segmentLibrary";
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
import { estimateVo2MaxFromRun, isEstimableEffort } from "../model/vo2MaxEstimate";
import {
  addStoredRun,
  clearStoredRuns,
  deleteStoredRun,
  listStoredRuns,
  markRunsWantedForFetch,
  setStoredRunRaceTags,
  setStoredRunSurfaceEdges,
  setVo2MaxEstimability,
  upsertStoredRunSummary,
  type StoredRun,
} from "../storage/runLibrary";
import { looksLikeGenericStravaTitle } from "../model/raceCandidates";
import { fitPacingMarginAcrossRaces, type PacingMarginFitResult } from "../model/pacingMarginFit";
import { resolveCeilingParams, resolveGlycogenStoreG, resolveLt1Lt2Fractions, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { ensurePointsForRun, getAutoFetchStatus, runAutoFetchBatch, subscribeToAutoFetch } from "./autoFetchRuns";
import { fetchSurfaceEdges } from "./surfaceLookup";
import { useStravaSession } from "./useStravaSession";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
  onApplyFInf: (fInf: number) => void;
  onApplySurfaceCostMultipliers: (multipliers: Partial<Record<SurfaceCategory, number>>) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onApplyPacingMargin: (fit: PacingMarginFitResult) => void;
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

/** suggestRunsForFit's own default (10 per bucket) is deliberately small --
 * it exists to keep a MANUAL review list short (see that file's own doc:
 * "meant to replace manually scanning hundreds of rows, not to invite
 * fetching all of them"). That rationale doesn't apply once fetching is
 * fully automatic (no one is scanning rows) -- a 10-per-bucket cap
 * silently starved a real backfill of 280 summaries down to just 10
 * downloaded runs, nowhere near enough moving time to fit anything. This
 * is the PER-BUCKET pool size fed into suggestRunsForFit -- generous on
 * purpose, since AUTO_FETCH_TOTAL_CAP below is what actually bounds how
 * many get fetched; this just needs to be large enough that each bucket
 * has enough of its own pool to pick a good, diverse set from before that
 * final cap trims the combined list down. */
const AUTO_FETCH_CANDIDATE_COUNT = 60;
/** The REAL ceiling on how many runs get auto-fetched in one pass, across
 * all three suggestion buckets combined -- suggestRunsForFit's own
 * candidateCount only bounds each bucket independently, so passing it
 * AUTO_FETCH_CANDIDATE_COUNT alone still let the deduped union balloon to
 * up to 3x that (a real 280-summary backfill produced 138 candidates, not
 * 60). This total is enforced by interleaving picks round-robin across the
 * three buckets before truncating, so a big vo2max pool can't crowd out
 * the durability/duration-spread picks the tau fit actually needs. */
const AUTO_FETCH_TOTAL_CAP = 60;

const DEFAULT_HALF_LIFE_DAYS = 75;
/** Only the strongest few estimates are shown -- see vo2MaxEstimates below
 * for why sorting by estimate descending is itself the intensity filter. */
const MAX_VO2MAX_ESTIMATES_SHOWN = 3;

/** A starting heuristic, not a tuned optimum -- at least half the variance
 * in this athlete's effort explained by HR alone before auto-applying the
 * HR-effort calibration. Below this, HR just isn't a reliable enough proxy
 * to trust automatically (still shown, and still manually applicable). */
const MIN_HR_CALIBRATION_R_SQUARED = 0.5;

/** A starting heuristic, not a tuned optimum -- same role as
 * MIN_INFORMATIVE_RACES for the tau/fInf fits, but scaled up: this fit
 * pools individual runs (not just races) into a single regression, so a
 * handful of runs isn't enough to trust the per-category split even though
 * the regression itself won't refuse to return a result. Below this, still
 * shown, still manually applicable, just not auto-applied. */
const MIN_SURFACE_FIT_RUNS = 10;

function oneYearAgoDateInput(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Persists the backfill "from" date across sessions (same localStorage
 * pattern as formInputs.ts's own settings) -- so a returning user doesn't
 * have to remember or re-enter it, and clicking the same button again
 * naturally becomes an incremental update: after a successful backfill,
 * this is advanced to today, so next time there's nothing to re-scan
 * except whatever's genuinely new since then. */
const LAST_BACKFILL_DATE_STORAGE_KEY = "grade-runner:lastBackfillDate";

function loadLastBackfillDate(): string | null {
  try {
    return localStorage.getItem(LAST_BACKFILL_DATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveLastBackfillDate(dateInput: string): void {
  try {
    localStorage.setItem(LAST_BACKFILL_DATE_STORAGE_KEY, dateInput);
  } catch {
    // Storage can fail (private browsing, quota) -- losing the saved date
    // just means the next visit falls back to the one-year-ago default,
    // not a functional break.
  }
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

/** Round-robin across several lists (one pick from each in turn) instead of
 * concatenating them -- used to combine the three suggestion buckets before
 * truncating to AUTO_FETCH_TOTAL_CAP, so a bucket with a big pool (e.g.
 * vo2max candidates) can't crowd out every pick from a smaller one (e.g.
 * duration-spread) just by coming first in a plain concat-then-slice. */
function interleave<T>(lists: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) result.push(list[i]);
    }
  }
  return result;
}

export function RunLibraryPanel({
  formInputs,
  onApplyTau,
  onApplyFInf,
  onApplySurfaceCostMultipliers,
  onApplyPacingMargin,
  onApplyHrCalibration,
  onAddVo2MaxEntry,
  onRacesFitted,
}: RunLibraryPanelProps) {
  const { connected: stravaConnected } = useStravaSession();
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<MultiRaceTauFitResult | null>(null);
  const [fInfFitResult, setFInfFitResult] = useState<FInfTauFitResult | null>(null);
  const [surfaceCostMultiplierFitResult, setSurfaceCostMultiplierFitResult] = useState<SurfaceCostMultiplierFitResult | null>(
    null,
  );
  const [hrCalibrationFitResult, setHrCalibrationFitResult] = useState<HrEffortCalibration | null>(null);
  const [pacingMarginFitResult, setPacingMarginFitResult] = useState<PacingMarginFitResult | null>(null);
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

  const [backfillFrom, setBackfillFrom] = useState(() => loadLastBackfillDate() ?? oneYearAgoDateInput());
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listStoredRuns().then(setRuns).catch((err) => setError(String(err)));
  }, []);

  // Computes "which summary-only runs are worth fetching full data for"
  // ONCE (via suggestRunsForFit + the same interleave-then-cap logic as
  // before) and PERSISTS the decision (StoredRun.wantsFullData), rather
  // than re-deriving it reactively on every render. Re-deriving reactively
  // was the actual cause of fetches appearing to "fail and restart":
  // listStoredRuns() (called by refresh()) returns a brand-new array every
  // time even when nothing meaningful changed, so any refresh() firing
  // anywhere (duplicate cleanup, a manual fit, etc.) gave the fetch
  // effect's own dependency a new-but-similar list, aborting whatever
  // iteration was in flight and restarting from a fresh (but nearly
  // identical) batch. Marking is idempotent and cheap to call again with
  // an unchanged candidate set (already-marked ids are just skipped).
  const markNewFetchCandidates = useCallback(async () => {
    const freshRuns = await listStoredRuns();
    const { kept } = dedupeStoredRuns(freshRuns);
    const suggestions = suggestRunsForFit(kept, AUTO_FETCH_CANDIDATE_COUNT);
    const interleaved = interleave([suggestions.vo2max, suggestions.durability, suggestions.durationSpread]);
    const byId = new Map<string, StoredRun>();
    for (const r of interleaved) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
    const candidateIds = [...byId.values()]
      .slice(0, AUTO_FETCH_TOTAL_CAP)
      .filter((r) => !r.wantsFullData)
      .map((r) => r.id);
    if (candidateIds.length > 0) await markRunsWantedForFetch(candidateIds);
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

  // Candidates for the race-tagging list below: fetched (points !== null,
  // so there's something to fit from) runs whose Strava title ISN'T one of
  // the auto-generated "Morning Run" style titles -- a real race is almost
  // always renamed. A suggestion only: pacingMarginFit.ts only ever uses
  // whatever the athlete explicitly confirms via raceTag, never this
  // heuristic directly (see raceCandidates.ts's own doc on why -- a real
  // check this session found the heuristic alone misclassified a club
  // interval session as a race).
  const raceCandidates = useMemo(
    () => dedupedRuns.filter((r) => r.points !== null && !looksLikeGenericStravaTitle(r.name)),
    [dedupedRuns],
  );
  const [raceTagSaving, setRaceTagSaving] = useState(false);
  const setRaceTag = async (id: string, raceTag: "race" | "notRace") => {
    setRaceTagSaving(true);
    try {
      await setStoredRunRaceTags([{ id, raceTag }]);
      refresh();
    } finally {
      setRaceTagSaving(false);
    }
  };

  // Silently cleans up duplicates as soon as they're found -- no button, no
  // warning banner. dedupedRuns already excludes them from every list/fit/
  // suggestion above, so nothing depends on this finishing quickly; it's
  // pure storage hygiene.
  useEffect(() => {
    if (duplicateGroups.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        for (const group of duplicateGroups) {
          for (const redundant of group.slice(1)) {
            if (cancelled) return;
            await deleteStoredRun(redundant.id);
          }
        }
        if (!cancelled) refresh();
      } catch {
        // Silent by design (matches the "no notification" ask) -- worst
        // case a duplicate lingers until the next render re-attempts it.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateGroups]);

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
      setSurfaceCostMultiplierFitResult(null);
      setHrCalibrationFitResult(null);
      setTransitGapCount(0);
      setExcludedForDurationCount(0);
      setFitRan(false);
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
      // Advances the saved date to today on ANY successful completion (even
      // zero new runs) -- it means everything up to today has now been
      // checked, so the next click (with no date change needed) only looks
      // for whatever's genuinely new since then, turning this same button
      // into an incremental "check for new runs" update.
      const today = new Date().toISOString().slice(0, 10);
      saveLastBackfillDate(today);
      setBackfillFrom(today);
      // Decides which of the just-imported summaries are worth fetching
      // full data for, ONCE, right here -- not left to be re-derived
      // reactively later (see markNewFetchCandidates' own doc).
      await markNewFetchCandidates();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed.");
    } finally {
      setBackfilling(false);
    }
  }, [backfillFrom, markNewFetchCandidates, refresh]);

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
  interface Vo2MaxCandidate {
    id: string;
    label: string;
    date: Date | null;
    estimateMlPerKgPerMin: number;
  }

  // Splits each run at any transit gap first (same fix as runFit() below --
  // a watch left running across a train/bus/car leg can hide a transit hop
  // inside an otherwise-real run, showing up as impossible pace; fed
  // straight into analyzeRun unsplit, that badly distorts (or, if it pushes
  // the whole span outside the estimable-duration window, silently drops)
  // the VO2max estimate for what would otherwise be a perfectly good run).
  // Each leg is its own candidate, dated from its own first point rather
  // than the whole run's start, since a later leg's actual effort happened
  // well after the run's nominal start time.
  // vo2MaxEstimable (see StoredRun's own doc) caches whether ANY of a run's
  // transit-split legs falls in the VO2max estimate's duration window --
  // that's decided purely by GPS-detected pauses (isEstimableEffort's own
  // input), never by formInputs, so it's safe to persist indefinitely and
  // skip re-running the whole transit-split + course-build pipeline for a
  // run already known to have no usable leg. The actual ESTIMATE VALUE
  // still depends on formInputs (bodyMassKg, ceilingParams, ...) and is
  // recomputed fresh every time regardless -- only the cheap duration gate
  // is cached, not the number itself.
  const vo2MaxComputation = useMemo(() => {
    const estimateCeilingParams = resolveCeilingParams(formInputs);
    const results: Vo2MaxCandidate[] = [];
    const newEstimabilityVerdicts: { id: string; estimable: boolean }[] = [];
    for (const run of dedupedRuns) {
      if (run.points === null) continue;
      if (run.vo2MaxEstimable === false) continue;
      const pointLegs = splitAtTransitGaps(run.points);
      let anyLegEstimable = false;
      for (let i = 0; i < pointLegs.length; i++) {
        const legPoints = pointLegs[i];
        const course = runPipeline(legPoints);
        if (!course.hasTimestamps) continue;
        if (pointLegs.length > 1 && course.totalDistance3D / 1000 < MIN_LEG_DISTANCE_KM) continue;
        const analysis = analyzeRun(course.segments, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams: estimateCeilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH },
          glycogenStoreG: resolveGlycogenStoreG(formInputs),
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        if (isEstimableEffort(analysis.totalMovingTimeS / 60)) anyLegEstimable = true;
        const estimateMlPerKgPerMin = estimateVo2MaxFromRun(analysis, estimateCeilingParams);
        if (estimateMlPerKgPerMin === null) continue;
        results.push({
          id: pointLegs.length > 1 ? `${run.id}-leg${i + 1}` : run.id,
          label: pointLegs.length > 1 ? `${run.name} (leg ${i + 1})` : run.name,
          date: legPoints[0]?.time ?? runDate(run),
          estimateMlPerKgPerMin,
        });
      }
      if (run.vo2MaxEstimable === undefined) newEstimabilityVerdicts.push({ id: run.id, estimable: anyLegEstimable });
    }
    return {
      estimates: results.sort((a, b) => b.estimateMlPerKgPerMin - a.estimateMlPerKgPerMin).slice(0, MAX_VO2MAX_ESTIMATES_SHOWN),
      newEstimabilityVerdicts,
    };
  }, [dedupedRuns, formInputs]);

  const vo2MaxEstimates = vo2MaxComputation.estimates;

  // Persists newly-determined verdicts once (see StoredRun.vo2MaxEstimable's
  // doc) -- refresh() afterward so dedupedRuns picks up the cached flag and
  // stops re-testing these runs on the next recompute.
  useEffect(() => {
    if (vo2MaxComputation.newEstimabilityVerdicts.length === 0) return;
    void setVo2MaxEstimability(vo2MaxComputation.newEstimabilityVerdicts).then(refresh);
  }, [vo2MaxComputation.newEstimabilityVerdicts, refresh]);

  const [addedVo2MaxRunIds, setAddedVo2MaxRunIds] = useState<Set<string>>(new Set());
  const addVo2MaxEstimate = (candidate: Vo2MaxCandidate) => {
    const date = candidate.date?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    onAddVo2MaxEntry({ date, value: Math.round(candidate.estimateMlPerKgPerMin), source: "race" });
    setAddedVo2MaxRunIds((prev) => new Set(prev).add(candidate.id));
  };

  /** Fetches and persists full points for a summary-only row; a no-op if
   * they're already present. */
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
        }
      }
      setTransitGapCount(detectedTransitGaps);
      setExcludedForDurationCount(excludedForDuration);
      const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates, halfLifeDays });
      setFitResult(safeFit.tauFit);
      setFInfFitResult(safeFit.fInfFit);
      setSafeFitTier(safeFit.tier);

      // Per-category surface cost, conditioned on recorded heart rate as the
      // effort signal instead of the solver's own max-sustainable-effort
      // assumption -- see fitSurfaceCostMultipliersFromIntensity's own doc
      // for why this replaced the flat unpavedCostMultiplier finish-time fit
      // that used to run here. Cheap relative to that: a single regression
      // over the whole library, no per-candidate solver simulation.
      const library = buildSegmentLibrary(libraryInputs, { bodyMassKg: formInputs.bodyMassKg, ceilingParams });
      const surfaceFit = fitSurfaceCostMultipliersFromIntensity(library);
      setSurfaceCostMultiplierFitResult(surfaceFit);
      if (surfaceFit && surfaceFit.runCount >= MIN_SURFACE_FIT_RUNS) {
        onApplySurfaceCostMultipliers(surfaceFit.surfaceCostMultipliers);
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

      // Pacing-margin curve (pacingMarginFit.ts): needs its OWN HR
      // calibration reading, not necessarily hrCalibrationFit above --
      // reuses it when available since refitting per-athlete HR-effort
      // slope/intercept from the same pool would just reproduce it, but
      // falls back to the lab-threshold calibration (if the athlete has
      // entered LT1/LT2 heart rate) so this can still run for someone whose
      // race-pool calibration didn't clear MIN_HR_CALIBRATION_R_SQUARED.
      const marginCalibration =
        hrCalibrationFit ??
        fitHrToEffortCalibrationFromThresholds(
          {
            lt1Fraction: formInputs.lt1Fraction,
            lt2Fraction: formInputs.lt2Fraction,
            lt1HeartRateBpm: formInputs.lt1HeartRateBpm,
            lt2HeartRateBpm: formInputs.lt2HeartRateBpm,
            fatOxPoints: formInputs.fatOxPoints,
            walkMaxMs: formInputs.walkMaxMs,
          },
          safeFit.ceilingParams,
        );
      const marginFit = marginCalibration
        ? fitPacingMarginAcrossRaces(confirmedRaceTrendPoints, confirmedRaceNames, marginCalibration)
        : null;
      setPacingMarginFitResult(marginFit);
      if (marginFit) {
        onApplyPacingMargin(marginFit);
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
      onRacesFitted?.(races, raceDates);
      refresh();

      // Auto-estimate the tau range right after the fit, using the races
      // computed just above directly (not the `lastFittedRaces` state,
      // which won't reflect this update until the next render) -- so the
      // range appears as part of the normal fit flow instead of requiring
      // a separate manual click. Still one bounded async step chained onto
      // an already-multi-second operation, not a live/reactive recompute.
      setComputingTauCI(true);
      setTauCI(null);
      try {
        const ci = await bootstrapTauConfidenceInterval(races, raceDates, ceilingParams);
        setTauCI(ci ?? "insufficient");
      } finally {
        setComputingTauCI(false);
      }
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

  // One-time catch-up for runs backfilled before this flag existed (or from
  // any earlier session where marking didn't happen yet) -- guarded so it
  // only ever fires once per mount, not on every dedupedRuns recompute.
  const ranCatchUpMarking = useRef(false);
  useEffect(() => {
    if (ranCatchUpMarking.current) return;
    if (!dedupedRuns.some((r) => r.points === null && !r.wantsFullData)) return;
    ranCatchUpMarking.current = true;
    void markNewFetchCandidates().then(refresh);
  }, [dedupedRuns, markNewFetchCandidates, refresh]);

  const pendingFetchRuns = useMemo(() => dedupedRuns.filter((r) => r.wantsFullData && r.points === null), [dedupedRuns]);
  // A plain string, not the array itself, so the effect below only kicks
  // off a new batch when the actual SET of pending ids changes -- not
  // every time dedupedRuns gets a new (but equivalent) array reference.
  const pendingFetchKey = useMemo(() => pendingFetchRuns.map((r) => r.id).sort().join(","), [pendingFetchRuns]);

  // Reads the shared auto-fetch module's status (see autoFetchRuns.ts) --
  // its batch loop lives OUTSIDE this component's lifecycle deliberately,
  // so closing Settings (which unmounts this whole panel) no longer stops
  // an in-progress download. useSyncExternalStore re-renders this component
  // whenever the module's status changes, even though the loop itself
  // isn't "owned" by this component at all.
  const autoFetchStatus = useSyncExternalStore(subscribeToAutoFetch, getAutoFetchStatus);

  // Kicks off (or no-ops into) a batch whenever there's marked-pending work
  // -- runAutoFetchBatch is itself idempotent against an already-running
  // batch, so it's safe to call this on every mount/remount (including
  // reopening Settings mid-download) without risking a duplicate,
  // competing fetch loop.
  useEffect(() => {
    if (pendingFetchRuns.length === 0) return;
    setError(null);
    void runAutoFetchBatch(pendingFetchRuns, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFetchKey]);

  useEffect(() => {
    if (autoFetchStatus.error) setError(autoFetchStatus.error);
  }, [autoFetchStatus.error]);

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
            Pulls a lightweight summary (distance, duration, elevation, avg heart rate/power) for every run since
            this date, then automatically fetches full GPS data for whichever of those are actually useful for the
            fits below (hard efforts, longest runs, duration spread) -- no manual selection needed. After a
            successful run, this date advances to today, so clicking the same button again only checks for
            whatever's genuinely new since then -- the same button doubles as an update check.
          </p>
          {backfillProgress && <p className="field-group-note">{backfillProgress}</p>}
        </>
      )}

      {error && <p className="gpx-upload__error">{error}</p>}

      {autoFetchStatus.running && (
        <p className="field-group-note">
          Fetching full data for recommended runs (hard efforts, longest runs, duration spread)
          {autoFetchStatus.progress ? ` -- ${autoFetchStatus.progress.done} of ${autoFetchStatus.progress.total}…` : "…"}
          {" "}Keeps running in the background even if you close Settings.
        </p>
      )}

      {dedupedRuns.length === 0 && <p className="placeholder">No runs stored yet.</p>}

      {!formInputs.pacingCurveEnabled && (
        <p className="field-group-note">
          The pacing curve is off (Settings -- Pacing curve). Fitting and applying tau/f_inf below still works, but
          won't affect your plan until it's back on.
        </p>
      )}

      {raceCandidates.length > 0 && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Confirm your races</p>
          <p className="field-group-help">
            Check the ones that were a continuous, all-out effort. Leave workouts and stop-start formats (e.g. a
            backyard ultra's run-then-rest-till-the-hour loops) unchecked -- only checked runs feed the pacing-margin
            curve below.
          </p>
          <table className="run-library__race-tag-table">
            <tbody>
              {raceCandidates.map((r) => (
                <tr key={r.id}>
                  <td>
                    <label className="run-library__race-tag-checkbox">
                      <input
                        type="checkbox"
                        checked={r.raceTag === "race"}
                        disabled={raceTagSaving}
                        onChange={(e) => void setRaceTag(r.id, e.target.checked ? "race" : "notRace")}
                      />
                      {r.name}
                    </label>
                  </td>
                  <td className="run-library__race-tag-date">{runDate(r)?.toISOString().slice(0, 10) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

      {surfaceCostMultiplierFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Terrain surface cost</p>
          <p className="field-group-help">
            One cost multiplier per surface category, applied while actually moving across it -- an instantaneous
            effect with no carryover to paved segments afterward, unlike a durability/fatigue term. Fit by
            conditioning on your own recorded heart rate as the effort signal, then asking how much slower you move
            at the SAME effort on each surface -- unlike a finish-time fit against the solver's theoretical ceiling,
            this doesn't assume you race at max sustainable effort with zero margin, so it isn't distorted by that
            assumption the way a flat multiplier fit against real finish times was. Surface fetched via a public
            OpenStreetMap map-matching lookup per run (fails silently and just leaves a run out if that lookup
            doesn't succeed). Every run with heart rate and surface data contributes, not just races -- this fit
            doesn't need race pacing to be valid.
          </p>
          <p className="field-group-note">
            Across {surfaceCostMultiplierFitResult.runCount} run{surfaceCostMultiplierFitResult.runCount === 1 ? "" : "s"} (
            {surfaceCostMultiplierFitResult.segmentCount} segments):
          </p>
          <ul className="field-group-note">
            {Object.entries(surfaceCostMultiplierFitResult.surfaceCostMultipliers).map(([category, multiplier]) => (
              <li key={category}>
                {category}: {multiplier!.toFixed(2)}x ({((multiplier! - 1) * 100).toFixed(0)}% slower at matched effort)
                {(surfaceCostMultiplierFitResult.variableInflationFactors[category as SurfaceCategory] ?? 0) > 5 && " -- shaky, high VIF"}
              </li>
            ))}
          </ul>
          {surfaceCostMultiplierFitResult.runCount < MIN_SURFACE_FIT_RUNS && (
            <p className="warning">
              Only {surfaceCostMultiplierFitResult.runCount} runs went into this fit -- with fewer than{" "}
              {MIN_SURFACE_FIT_RUNS}, treat these multipliers with real caution.
            </p>
          )}
          <button
            type="button"
            className="fatox-add"
            onClick={() => onApplySurfaceCostMultipliers(surfaceCostMultiplierFitResult.surfaceCostMultipliers)}
          >
            Apply per-category costs
          </button>
          <p className="field-group-note">
            {surfaceCostMultiplierFitResult.runCount >= MIN_SURFACE_FIT_RUNS
              ? "Applied automatically -- enough runs to trust this."
              : "Not applied automatically -- see the note above; you can still apply it manually if you trust it."}
          </p>
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

      {pacingMarginFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Pacing margin -- chosen effort vs. race length</p>
          <p className="field-group-help">
            findSustainableTheta's own search returns 100% of your fitted ceiling for any race under ~6-8h (fuel
            never becomes the binding constraint that short) -- but your own heart rate during a race shows you don't
            actually run at that: this curve is fit from your confirmed races' own HR-implied effort, early-window
            only, so it isn't distorted by end-of-race cardiac drift. It's the "chosen pacing" number shown alongside
            your predicted finish time -- separate from, and layered UNDER, the theoretical ceiling.
          </p>
          <p className="field-group-note">
            Fit from {pacingMarginFitResult.raceCount} confirmed race{pacingMarginFitResult.raceCount === 1 ? "" : "s"}, spanning{" "}
            {pacingMarginFitResult.minDurationHours.toFixed(1)}-{pacingMarginFitResult.maxDurationHours.toFixed(1)}h. Predictions
            for a race outside that range are an extrapolation, not something any confirmed race actually tested.
          </p>
          <table className="run-library__race-tag-table">
            <tbody>
              {pacingMarginFitResult.perRace.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="run-library__race-tag-date">{p.durationHours.toFixed(2)}h</td>
                  <td className="run-library__race-tag-date">
                    {p.chosenTheta !== null ? `chosen ${(p.chosenTheta * 100).toFixed(0)}%` : "no HR data"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-group-note">Applied automatically -- {pacingMarginFitResult.raceCount} confirmed races cleared the minimum to fit this curve.</p>
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
            {vo2MaxEstimates.map((candidate) => {
              const added = addedVo2MaxRunIds.has(candidate.id);
              return (
                <div key={candidate.id} className="run-library-row">
                  <span className="run-library-row__label">
                    {candidate.label} &middot; {candidate.date ? candidate.date.toISOString().slice(0, 10) : "unknown date"} &middot; est.
                    VO2max {candidate.estimateMlPerKgPerMin.toFixed(1)} ml/kg/min
                  </span>
                  <button type="button" className="fatox-add" onClick={() => addVo2MaxEstimate(candidate)} disabled={added}>
                    {added ? "Added" : "Add to history"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
