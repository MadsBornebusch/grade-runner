import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SurfaceCategory } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import {
  bootstrapTauConfidenceInterval,
  MIN_INFORMATIVE_RACES,
  suggestFitImprovements,
  type EffortTrendPoint,
  type TauConfidenceInterval,
} from "../model/pacingFit";
import { DURABILITY_MIN_DURATION_S, suggestRunsForFit } from "../model/suggestRuns";
import { dedupeStoredRuns } from "../model/dedupeRuns";
import { splitAtTransitGaps } from "../gpx/transitGap";
import { fitHrToEffortCalibrationFromThresholds, predictHeartRateFromEffortFraction } from "../model/hrCalibration";
import { sustainableFraction } from "../model/ceiling";
import { estimateVo2MaxFromRun, isEstimableEffort } from "../model/vo2MaxEstimate";
import {
  addStoredRun,
  clearStoredRuns,
  deleteStoredRun,
  listStoredRuns,
  markRunsWantedForFetch,
  setStoredRunRaceTags,
  setVo2MaxEstimability,
  type StoredRun,
} from "../storage/runLibrary";
import { looksLikeGenericStravaTitle } from "../model/raceCandidates";
import { MIN_MARGIN_FIT_RACES, type PacingMarginFitResult } from "../model/pacingMarginFit";
import { resolveCeilingParams, resolveGlycogenStoreG, resolveLt1Lt2Fractions, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { getAutoFetchStatus, runAutoFetchBatch, subscribeToAutoFetch } from "./autoFetchRuns";
import { getBackfillStatus, runBackfillBatch, subscribeToBackfill } from "./backfillRuns";
import {
  getRunFitStatus,
  MIN_HR_CALIBRATION_R_SQUARED,
  MIN_LEG_DISTANCE_KM,
  MIN_SURFACE_FIT_RUNS,
  resetRunFitStatus,
  runDate,
  runFitBatch,
  subscribeToRunFit,
} from "./runFitBatch";
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
  // Module-level (see runFitBatch.ts's own doc) -- survives closing and
  // reopening Settings mid-fit instead of silently losing progress, and
  // stops a second concurrent fit from starting if the button gets
  // clicked again while one's already running.
  const runFitStatus = useSyncExternalStore(subscribeToRunFit, getRunFitStatus);
  const fitting = runFitStatus.running;
  const fitRan = runFitStatus.result !== null;
  const fitResult = runFitStatus.result?.fitResult ?? null;
  const fInfFitResult = runFitStatus.result?.fInfFitResult ?? null;
  const surfaceCostMultiplierFitResult = runFitStatus.result?.surfaceFit ?? null;
  const hrCalibrationFitResult = runFitStatus.result?.hrCalibrationFit ?? null;
  const pacingMarginFitResult = runFitStatus.result?.marginFit ?? null;
  const safeFitTier = runFitStatus.result?.safeFitTier ?? null;
  const transitGapCount = runFitStatus.result?.transitGapCount ?? 0;
  const excludedForDurationCount = runFitStatus.result?.excludedForDurationCount ?? 0;
  const lastFittedRaces = runFitStatus.result
    ? { races: runFitStatus.result.races, raceDates: runFitStatus.result.raceDates }
    : null;
  // A manual re-estimate (button below) overrides the auto-computed one --
  // bootstrap resampling is random, so re-clicking gives a fresh read on
  // the same underlying data without re-running the whole fit.
  const [manualTauCI, setManualTauCI] = useState<TauConfidenceInterval | "insufficient" | null>(null);
  const [computingTauCI, setComputingTauCI] = useState(false);
  const tauCI = manualTauCI ?? runFitStatus.result?.tauCI ?? null;
  const [halfLifeDays, setHalfLifeDays] = useState(DEFAULT_HALF_LIFE_DAYS);

  const [backfillFrom, setBackfillFrom] = useState(() => loadLastBackfillDate() ?? oneYearAgoDateInput());
  // Module-level (see backfillRuns.ts's own doc) -- survives closing and
  // reopening Settings mid-backfill instead of silently losing progress.
  const backfillStatus = useSyncExternalStore(subscribeToBackfill, getBackfillStatus);

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
    // namedRace gets its OWN budget, additive to AUTO_FETCH_TOTAL_CAP below
    // rather than competing for a slot inside it -- real races are a small
    // (typically well under a dozen), categorically more valuable
    // population than another vo2max/durability/spread pick, so adding
    // this bucket must never shrink how many of THOSE get fetched.
    const interleaved = interleave([suggestions.vo2max, suggestions.durability, suggestions.durationSpread]);
    const byId = new Map<string, StoredRun>();
    for (const r of suggestions.namedRace) byId.set(r.id, r);
    for (const r of interleaved.slice(0, AUTO_FETCH_TOTAL_CAP)) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
    const candidateIds = [...byId.values()]
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
      resetRunFitStatus();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear the run library.");
    } finally {
      setClearing(false);
    }
  };

  // Idempotent (backfillRuns.ts no-ops a call while one's already running),
  // so it's safe to call on every click without tracking "is one already
  // in flight" here -- same discipline as markNewFetchCandidates/
  // runAutoFetchBatch elsewhere in this file.
  const runBackfill = useCallback(() => {
    setError(null);
    void runBackfillBatch(backfillFrom, () => {
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
      void markNewFetchCandidates().then(refresh);
    });
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

  /** The fit pipeline itself lives in runFitBatch.ts now (see that file's
   * own doc for why) -- idempotent (a call while one's already running is a
   * no-op), so it's safe to call on every click without tracking "is one
   * already in flight" here. */
  const runFit = () => {
    // Automatic: every stored run with full GPS data already fetched is a
    // CANDIDATE for the fit, no manual curation needed -- runs still
    // summary-only (backfilled but not fetched) are simply left out until
    // fetched via the suggestions below or a direct import. Candidates
    // themselves are still filtered by duration inside runFitBatch
    // (DURABILITY_MIN_DURATION_S) before actually feeding the pooled fits.
    const readyRuns = dedupedRuns.filter((r) => r.points !== null);
    setError(null);
    void runFitBatch(readyRuns, formInputs, ceilingParams, halfLifeDays, {
      onApplyTau,
      onApplyFInf,
      onApplySurfaceCostMultipliers,
      onApplyHrCalibration,
      onApplyPacingMargin,
      onRacesFitted,
    }).then(refresh);
  };

  /** On-demand, not a live recompute -- ~100 sequential tau refits is too
   * slow to run on every render. Reuses the exact races/raceDates from the
   * fit above, so this needs no target course or solver at all. */
  const handleEstimateTauCI = async () => {
    if (!lastFittedRaces) return;
    setComputingTauCI(true);
    setManualTauCI(null);
    try {
      const ci = await bootstrapTauConfidenceInterval(lastFittedRaces.races, lastFittedRaces.raceDates, ceilingParams);
      setManualTauCI(ci ?? "insufficient");
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

  useEffect(() => {
    if (backfillStatus.error) setError(backfillStatus.error);
  }, [backfillStatus.error]);

  useEffect(() => {
    if (runFitStatus.error) setError(runFitStatus.error);
  }, [runFitStatus.error]);

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
        1) Backfill from a date below. 2) Wait for runs to download. 3) Confirm your races. 4) Hit the fit button.
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
            <button type="button" className="fatox-add" onClick={runBackfill} disabled={backfillStatus.running}>
              {backfillStatus.running ? "Fetching…" : "Backfill"}
            </button>
          </div>
          <p className="field-group-help">
            Click again later to check for new runs since your last backfill.
          </p>
        </>
      )}

      {error && <p className="gpx-upload__error">{error}</p>}

      <p className="run-library__status">
        {fitting ? (
          "Fitting your athlete model — tau/f_inf, terrain cost, HR calibration, pacing margin…"
        ) : backfillStatus.running ? (
          backfillStatus.progress ?? "Fetching your run history…"
        ) : autoFetchStatus.running ? (
          <>
            Downloading full data for your races and other useful runs
            {autoFetchStatus.progress ? ` — ${autoFetchStatus.progress.done} of ${autoFetchStatus.progress.total}…` : "…"}
          </>
        ) : pendingFetchRuns.length > 0 ? (
          `${pendingFetchRuns.length} run${pendingFetchRuns.length === 1 ? "" : "s"} queued to download…`
        ) : readyCount > 0 ? (
          `✓ ${readyCount} run${readyCount === 1 ? "" : "s"} downloaded and ready. Confirm your races below, then fit.`
        ) : dedupedRuns.length === 0 ? (
          "No runs stored yet."
        ) : null}
      </p>

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
            Check continuous, all-out efforts. Leave workouts and stop-start formats (e.g. backyard ultra loops)
            unchecked.
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
          <button type="button" className="fatox-add" onClick={runFit} disabled={readyCount === 0 || fitting}>
            {fitting
              ? "Fitting…"
              : `Fit full athlete model from ${readyCount} downloaded run${readyCount === 1 ? "" : "s"}`}
          </button>
          <p className="field-group-help">
            Fits and applies tau/f_inf, terrain cost, HR calibration, and pacing margin all at once.
          </p>
        </>
      )}

      {dedupedRuns.length > 0 && (
        <div className="run-library__applied-summary">
          <p className="field-group-note">Currently applied</p>
          <ul>
            <li>
              Pacing fade: f0 {formInputs.f0.toFixed(2)}, f_inf {formInputs.fInf.toFixed(2)}, tau{" "}
              {formInputs.tauMin.toFixed(0)} min
            </li>
            <li>
              Terrain cost:{" "}
              {formInputs.surfaceCostMultipliers && Object.keys(formInputs.surfaceCostMultipliers).length > 0
                ? Object.entries(formInputs.surfaceCostMultipliers)
                    .map(([c, m]) => `${c} ${m!.toFixed(2)}x`)
                    .join(", ")
                : "not fit yet"}
            </li>
            <li>HR calibration: {formInputs.hrEffortCalibrationSlope !== null ? "fit" : "not fit yet"}</li>
            <li>
              Pacing margin:{" "}
              {formInputs.pacingMargin
                ? `f_inf ${formInputs.pacingMargin.marginFInf.toFixed(2)}, tau ${formInputs.pacingMargin.marginTauHours.toFixed(1)}h`
                : `not fit yet -- confirm ${MIN_MARGIN_FIT_RACES}+ races above`}
            </li>
          </ul>
        </div>
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
          <p className="field-group-help">How much tau would vary on a slightly different sample of your runs.</p>
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
            Fits fInf and tau together, holding VO2max and f0 fixed. Doesn't independently verify VO2max or f0 --
            fInf absorbs any error in both.
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
            One cost multiplier per surface category, from how much slower you move at the same heart rate on each
            surface. Every run with heart rate and surface data contributes, not just races -- this fit
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
            Maps heart rate to effort fraction, fit from each race's early portion (least cardiac drift). Doesn't
            affect pace/power predictions -- used for HR-based effort estimates elsewhere (e.g. Analysis mode).
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
            How much of your fitted ceiling you actually hold, by race length -- fit from your confirmed races' own
            heart rate. Drives the "Chosen pacing" number shown with your predicted finish time.
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
              <p className="field-group-help">Checks whether the calibration above agrees with your entered LT1/LT2 heart rate.</p>
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
            Same mapping as above, but fit from your lab-measured LT1/LT2/fat-ox thresholds instead of training runs.
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
            From near-maximal 20-90 minute efforts. Top {MAX_VO2MAX_ESTIMATES_SHOWN} shown, highest first. Review
            before adding -- accepted entries are weighted like a "race" source.
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
