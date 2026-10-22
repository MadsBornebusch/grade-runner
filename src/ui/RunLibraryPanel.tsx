import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SurfaceCategory } from "../gpx/pipeline";
import { runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import { DURABILITY_MIN_DURATION_S } from "../model/suggestRuns";
import { DEFAULT_HALF_LIFE_DAYS, loadLastFitAt, markNewFetchCandidates, saveFitInputsKeyAfterManualFit } from "./modelRefresh";
import { dedupeStoredRuns } from "../model/dedupeRuns";
import { splitAtTransitGaps } from "../gpx/transitGap";
import { fitHrToPowerCalibrationFromThresholds, predictHeartRateFromPower } from "../model/hrCalibration";
import { maxAerobicPower } from "../model/ceiling";
import { estimateVo2MaxFromRun, isEstimableEffort } from "../model/vo2MaxEstimate";
import {
  clearStoredRuns,
  deleteStoredRun,
  listStoredRuns,
  setStoredRunRaceTags,
  setVo2MaxEstimability,
  type StoredRun,
} from "../storage/runLibrary";
import { looksLikeGenericStravaTitle } from "../model/raceCandidates";
import { MIN_MARGIN_FIT_RACES, type PacingMarginFitResult } from "../model/pacingMarginFit";
import {
  MIN_DESCENT_CAP_DISTANCE_M,
  MIN_DURATION_CEILING_RACES,
  MIN_DURATION_CEILING_SPAN_RATIO,
} from "../model/pacingFit";
import type { DescentCapCurve } from "../model/minetti";
import { resolveCeilingParams, resolveGlycogenStoreG, resolveLt1Lt2Fractions, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import {
  ensurePointsForRun,
  getAutoFetchStatus,
  isDueForFetch,
  runAutoFetchBatch,
  subscribeToAutoFetch,
} from "./autoFetchRuns";
import { getBackfillStatus, runBackfillBatch, subscribeToBackfill } from "./backfillRuns";
import { loadLastBackfillDate, saveLastBackfillDate } from "./syncOnOpen";
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
  onApplySurfaceCostMultipliers: (multipliers: Partial<Record<SurfaceCategory, number>>) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onApplyPacingMargin: (fit: PacingMarginFitResult) => void;
  onApplyDescentCapCurve: (curve: DescentCapCurve) => void;
  onApplyDurationCeiling: (fraction60Min: number, exponent: number) => void;
  onApplyAnaerobicCapacityMin: (anaerobicCapacityMin: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
}


/** m/s as a min/km pace string -- the descent cap is stored as a speed but
 * is only legible to a runner as a pace. */
function paceFromMs(speedMs: number): string {
  if (!(speedMs > 0)) return "--";
  const s = 1000 / speedMs;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Only the strongest few estimates are shown -- see vo2MaxEstimates below
 * for why sorting by estimate descending is itself the intensity filter. */
const MAX_VO2MAX_ESTIMATES_SHOWN = 3;

function twoYearsAgoDateInput(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
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

/** "just now" / "3 hours ago" / "2 days ago" -- so a stale fit is obvious
 * at a glance rather than needing the timestamp read carefully. */
function formatRelativeAge(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function RunLibraryPanel({
  formInputs,
  onApplySurfaceCostMultipliers,
  onApplyPacingMargin,
  onApplyDescentCapCurve,
  onApplyDurationCeiling,
  onApplyAnaerobicCapacityMin,
  onApplyHrCalibration,
  onAddVo2MaxEntry,
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
  const fitCompletedAt = runFitStatus.result?.completedAt ?? null;
  const surfaceCostMultiplierFitResult = runFitStatus.result?.surfaceFit ?? null;
  const hrCalibrationFitResult = runFitStatus.result?.hrCalibrationFit ?? null;
  const pacingMarginFitResult = runFitStatus.result?.marginFit ?? null;
  const durationCeilingFitResult = runFitStatus.result?.durationCeilingFit ?? null;
  const descentCapFitResult = runFitStatus.result?.descentCapFit ?? null;
  // Once the duration-ceiling envelope is fitted, sustainableFraction takes
  // the power-law branch and never reads f0, f_inf or tau (ceiling.ts), and
  // the solver stops passing total distance to maxDescentSpeedMs so the
  // descent PACING curve never reaches it either. The panels describing
  // those parameters are hidden rather than annotated: a number on screen
  // that changes nothing about the plan is noise however carefully it is
  // labelled. They still render for an athlete without enough confirmed
  // races for the envelope, where those fits ARE their ceiling.
  const anaerobicFitResult = runFitStatus.result?.anaerobicFit ?? null;
  const transitGapCount = runFitStatus.result?.transitGapCount ?? 0;
  const excludedForDurationCount = runFitStatus.result?.excludedForDurationCount ?? 0;

  const [halfLifeDays, setHalfLifeDays] = useState(DEFAULT_HALF_LIFE_DAYS);

  const [backfillFrom, setBackfillFrom] = useState(() => loadLastBackfillDate() ?? twoYearsAgoDateInput());
  // Module-level (see backfillRuns.ts's own doc) -- survives closing and
  // reopening Settings mid-backfill instead of silently losing progress.
  const backfillStatus = useSyncExternalStore(subscribeToBackfill, getBackfillStatus);

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

  // Candidates for the race-tagging list below: any backfilled run (points
  // fetched or not -- a title is all tagging needs) whose Strava title ISN'T
  // one of the auto-generated "Morning Run" style titles -- a real race is
  // almost always renamed. Deliberately NOT gated on points !== null: that
  // used to force waiting for the (slow) heuristic full-data auto-fetch to
  // finish before a single race could even be reviewed, even though titles
  // are available straight off the (fast, cheap) backfill summary. A
  // suggestion only: pacingMarginFit.ts only ever uses whatever the athlete
  // explicitly confirms via raceTag, never this heuristic directly (see
  // raceCandidates.ts's own doc on why -- a real check this session found
  // the heuristic alone misclassified a club interval session as a race).
  const raceCandidates = useMemo(
    () => dedupedRuns.filter((r) => !looksLikeGenericStravaTitle(r.name)),
    [dedupedRuns],
  );
  // Per-row, not one shared flag -- tagging itself is a cheap local write
  // (no network), so multiple rows can be tagged back to back without
  // blocking on each other. Only a row whose points still need fetching
  // (see setRaceTag below) shows as busy, and only that row.
  const [fetchingRaceIds, setFetchingRaceIds] = useState<Set<string>>(new Set());
  const setRaceTag = async (run: StoredRun, raceTag: "race" | "notRace") => {
    await setStoredRunRaceTags([{ id: run.id, raceTag }]);
    refresh();
    // Fetch this run's full data right away, ahead of (not queued behind)
    // whatever the broader heuristic auto-fetch batch is doing -- a race
    // the athlete just explicitly confirmed is exactly what the pacing-
    // margin fit needs, and shouldn't have to wait its turn in a 60-run
    // speculative batch to become usable.
    if (raceTag === "race" && run.points === null) {
      setFetchingRaceIds((prev) => new Set(prev).add(run.id));
      try {
        await ensurePointsForRun(run);
      } finally {
        setFetchingRaceIds((prev) => {
          const next = new Set(prev);
          next.delete(run.id);
          return next;
        });
        refresh();
      }
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
  }, [backfillFrom, refresh]);


  const ceilingParams = resolveCeilingParams(formInputs);

  // Lab-derived HR calibration -- from the athlete's own entered LT1/LT2
  // heart rate and (optionally) fat-ox-curve heart rate, not from any
  // imported training runs. Needs no fitting/import step, so this is
  // computed eagerly from formInputs alone; the training-history calibration
  // below still requires runs to have been fitted.
  const thresholdHrCalibrationFitResult = useMemo(() => {
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    return fitHrToPowerCalibrationFromThresholds(
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
    // Narrow, explicit field list -- same discipline as
    // thresholdHrCalibrationFitResult just above -- rather than the whole
    // formInputs object. This loop runs a full runPipeline+analyzeRun per
    // downloaded run (hundreds for an established library), so depending
    // on all of formInputs meant literally any keystroke anywhere in
    // Settings (a display-unit toggle, a split length, an unrelated field)
    // re-ran the whole thing -- the actual cause of Settings feeling like
    // it hangs while typing. Only the fields resolveCeilingParams/
    // resolveGlycogenStoreG/this loop's own body actually read belong here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dedupedRuns,
    formInputs.bodyMassKg,
    formInputs.vo2MaxHistory,
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.walkMaxMs,
    formInputs.durabilityDriftPerHour,
    formInputs.intakeGPerH,
    formInputs.glycogenGPerKg,
    formInputs.altitudeAdjustment,
  ]);

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
      onApplySurfaceCostMultipliers,
      onApplyHrCalibration,
      onApplyPacingMargin,
      onApplyDescentCapCurve,
      onApplyDurationCeiling,
      onApplyAnaerobicCapacityMin,
    }).then(() => {
      if (!getRunFitStatus().error) void saveFitInputsKeyAfterManualFit();
      refresh();
    });
  };

  /** On-demand, not a live recompute -- ~100 sequential tau refits is too
   * slow to run on every render. Reuses the exact races/raceDates from the
   * fit above, so this needs no target course or solver at all. */

  // One-time catch-up for runs backfilled before this flag existed (or from
  // any earlier session where marking didn't happen yet) -- guarded so it
  // only ever fires once per mount, not on every dedupedRuns recompute.
  const ranCatchUpMarking = useRef(false);
  useEffect(() => {
    if (ranCatchUpMarking.current) return;
    if (!dedupedRuns.some((r) => r.points === null && !r.wantsFullData)) return;
    ranCatchUpMarking.current = true;
    void markNewFetchCandidates().then(refresh);
  }, [dedupedRuns, refresh]);

  // isDueForFetch keeps runs that have repeatedly failed to download out of
  // the auto batch (see autoFetchRuns.ts) -- without it, a run that can
  // never produce points is re-queued on every single app launch.
  const pendingFetchRuns = useMemo(
    () => dedupedRuns.filter((r) => r.wantsFullData && r.points === null && isDueForFetch(r)),
    [dedupedRuns],
  );
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

  const fittedAt = runFitStatus.result?.completedAt ?? loadLastFitAt();
  const status = fitting
    ? `Updating your model${runFitStatus.progress ? ` (${runFitStatus.progress.done} of ${runFitStatus.progress.total})` : ""}…`
    : backfillStatus.running
      ? "Checking Strava for new runs…"
      : autoFetchStatus.running
        ? `Downloading GPS for useful runs${autoFetchStatus.progress ? ` (${autoFetchStatus.progress.done} of ${autoFetchStatus.progress.total})` : ""}…`
        : pendingFetchRuns.length > 0
          ? `${pendingFetchRuns.length} run${pendingFetchRuns.length === 1 ? "" : "s"} waiting to download.`
          : fittedAt
            ? `Model updated ${formatRelativeAge(fittedAt)}.`
            : null;
  const surfaces = Object.entries(formInputs.surfaceCostMultipliers ?? {});
  const hrAtHour =
    formInputs.hrPowerCalibrationSlope !== null && formInputs.hrPowerCalibrationIntercept !== null
      ? Math.round(
          predictHeartRateFromPower(formInputs.powerLawFraction60Min * maxAerobicPower(0, ceilingParams), {
            slope: formInputs.hrPowerCalibrationSlope,
            intercept: formInputs.hrPowerCalibrationIntercept,
            rSquared: 1,
            pointCount: 0,
            raceCount: 0,
          }),
        )
      : null;
  const confirmedRaces = raceCandidates.filter((r) => r.raceTag === "race").length;

  return (
    <>
      <section>
        <h3 className="section-title">Your runs</h3>
        <div className="card runs-card">
          <div className="form-row">
            <span className="num">
              {dedupedRuns.length} run{dedupedRuns.length === 1 ? "" : "s"}
              <span className="muted"> · {readyCount} with GPS</span>
            </span>
            {stravaConnected && (
              <button type="button" className="button-ghost" onClick={runBackfill} disabled={backfillStatus.running}>
                {backfillStatus.running ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
          {status && <p className="help">{status}</p>}
          {error && <p className="help danger">{error}</p>}
          {stravaConnected && (
            <p className="help">
              New runs sync each time you open the app, and the model updates when they bring something new.
            </p>
          )}
        </div>
      </section>

      {raceCandidates.length > 0 && (
        <section>
          <h3 className="section-title">Your races</h3>
          <div className="card">
            <p className="help">
              Tick continuous, all-out races; leave workouts and backyard loops unticked. Confirmed races teach the model how you pace a race.
            </p>
            <div className="race-checklist">
              {[...raceCandidates].sort((x, y) => (runDate(y)?.getTime() ?? 0) - (runDate(x)?.getTime() ?? 0)).map((r) => (
                <label key={r.id} className="race-checklist__row">
                  <input
                    type="checkbox"
                    checked={r.raceTag === "race"}
                    disabled={fetchingRaceIds.has(r.id)}
                    onChange={(e) => void setRaceTag(r, e.target.checked ? "race" : "notRace")}
                  />
                  <span>{r.name}{fetchingRaceIds.has(r.id) && " (downloading…)"}</span>
                  <span className="num muted">{runDate(r)?.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) ?? ""}</span>
                </label>
              ))}
            </div>
          </div>
        </section>
      )}

      {dedupedRuns.length > 0 && (
        <section>
          <h3 className="section-title">What your runs say</h3>
          <div className="card">
            <dl className="facts learned">
              <dt>Endurance</dt>
              <dd className="num">About {Math.round(formInputs.powerLawFraction60Min * 100)}% of your VO2max for an hour</dd>
              <dt>Race pacing</dt>
              <dd className="num">
                {formInputs.pacingMargin
                  ? `Learned from your races: in the longest ones you hold about ${Math.round(formInputs.pacingMargin.marginFInf * 100)}% of what you could`
                  : `Confirm ${MIN_MARGIN_FIT_RACES} or more races to learn it (${confirmedRaces} so far)`}
              </dd>
              <dt>Downhills</dt>
              <dd className="num">
                {formInputs.descentCapCurve
                  ? `${paceFromMs(formInputs.descentCapCurve.onsetSpeedMs)}/km on a −10% slope, ${paceFromMs(formInputs.descentCapCurve.clampSpeedMs)}/km on −45%`
                  : "Not enough descent yet; a typical curve stands in"}
              </dd>
              <dt>Terrain</dt>
              <dd className="num">
                {surfaces.length > 0
                  ? surfaces.map(([c, m]) => `${c} ${m! >= 1 ? "+" : "−"}${Math.abs(Math.round((m! - 1) * 100))}%`).join(", ")
                  : "Not learned yet"}
              </dd>
              <dt>Heart rate</dt>
              <dd className="num">{hrAtHour !== null ? `About ${hrAtHour} bpm at your one-hour effort` : "Not learned yet"}</dd>
            </dl>
            <div className="sheet__actions">
              <button type="button" className="button-ghost" onClick={runFit} disabled={readyCount === 0 || fitting}>
                {fitting ? "Updating…" : "Update now"}
              </button>
            </div>
          </div>
        </section>
      )}

      {vo2MaxEstimates.length > 0 && (
        <section>
          <h3 className="section-title">VO2max from your hard efforts</h3>
          <div className="card list">
            <p className="help list-help">Near-maximal 20–90 min efforts, best {MAX_VO2MAX_ESTIMATES_SHOWN} first. Added ones count like a race estimate.</p>
            {vo2MaxEstimates.map((candidate) => {
              const added = addedVo2MaxRunIds.has(candidate.id);
              return (
                <div key={candidate.id} className="list-row">
                  <span>
                    {candidate.label}
                    <span className="num muted course-list__facts">
                      {" "}
                      · {candidate.date ? candidate.date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "no date"} ·{" "}
                      {candidate.estimateMlPerKgPerMin.toFixed(1)}
                    </span>
                  </span>
                  <button type="button" className="button-ghost" onClick={() => addVo2MaxEstimate(candidate)} disabled={added}>
                    {added ? "Added" : "Add"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {dedupedRuns.length > 0 && (
        <details className="lab card">
          <summary>Lab: fit details</summary>
          <div className="lab__body">
            <label className="form-row">
              <span>Recency half-life</span>
              <span className="input-unit">
                <input type="number" min={1} value={halfLifeDays} onChange={(e) => setHalfLifeDays(Number(e.target.value))} />
                days
              </span>
            </label>
            <p className="help">Older runs count for less. Used by "Update now"; automatic updates use {DEFAULT_HALF_LIFE_DAYS} days.</p>
            {stravaConnected && (
              <label className="form-row">
                <span>Sync runs since</span>
                <input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} />
              </label>
            )}

            {fitCompletedAt !== null && (
              <p className="help">
                Fitted {new Date(fitCompletedAt).toLocaleString()} ({formatRelativeAge(fitCompletedAt)}) from{" "}
                {runFitStatus.result?.races.length ?? 0} runs.
              </p>
            )}

            {transitGapCount > 0 && (
              <p className="help">
                Detected and cropped out {transitGapCount} transit gap{transitGapCount === 1 ? "" : "s"} (GPS jumps far
                faster than running is possible, typically a watch left running across a train/bus/car leg) -- the
                genuine running before and after each gap was still used, just as separate legs.
              </p>
            )}

            {excludedForDurationCount > 0 && (
              <p className="help">
                Left out {excludedForDurationCount} run{excludedForDurationCount === 1 ? "" : "s"} under{" "}
                {(DURABILITY_MIN_DURATION_S / 60).toFixed(0)} minutes -- too short to contribute a usable effort trend.
              </p>
            )}

            {surfaceCostMultiplierFitResult && (
              <div className="lab__section">
                <h4 className="lab__title">Terrain surface cost</h4>
                <p className="help">
                  One cost multiplier per surface category, from how much slower you move at the same heart rate on each
                  surface. Every run with heart rate and surface data contributes, not just races -- this fit
                  doesn't need race pacing to be valid.
                </p>
                <p className="help">
                  Across {surfaceCostMultiplierFitResult.runCount} run{surfaceCostMultiplierFitResult.runCount === 1 ? "" : "s"} (
                  {surfaceCostMultiplierFitResult.segmentCount} segments):
                </p>
                <ul className="help lab-list">
                  {Object.entries(surfaceCostMultiplierFitResult.surfaceCostMultipliers).map(([category, multiplier]) => (
                    <li key={category}>
                      {category}: {multiplier!.toFixed(2)}x ({((multiplier! - 1) * 100).toFixed(0)}% slower at matched effort)
                      {(surfaceCostMultiplierFitResult.variableInflationFactors[category as SurfaceCategory] ?? 0) > 5 && " -- shaky, high VIF"}
                    </li>
                  ))}
                </ul>
                {surfaceCostMultiplierFitResult.runCount < MIN_SURFACE_FIT_RUNS && (
                  <p className="help danger">
                    Only {surfaceCostMultiplierFitResult.runCount} runs went into this fit -- with fewer than{" "}
                    {MIN_SURFACE_FIT_RUNS}, treat these multipliers with real caution.
                  </p>
                )}
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={() => onApplySurfaceCostMultipliers(surfaceCostMultiplierFitResult.surfaceCostMultipliers)}
                >
                  Apply per-category costs
                </button>
                <p className="help">
                  {surfaceCostMultiplierFitResult.runCount >= MIN_SURFACE_FIT_RUNS
                    ? "Applied automatically -- enough runs to trust this."
                    : "Not applied automatically -- see the note above; you can still apply it manually if you trust it."}
                </p>
              </div>
            )}

            {hrCalibrationFitResult && (
              <div className="lab__section">
                <h4 className="lab__title">HR-effort calibration: from your training history</h4>
                <p className="help">
                  Maps heart rate to effort fraction, fit from each race's early portion (least cardiac drift). Doesn't
                  affect pace/power predictions -- used for HR-based effort estimates elsewhere (e.g. Analysis mode).
                </p>
                <p className="help">
                  Best fit: effort fraction ≈ {hrCalibrationFitResult.intercept.toFixed(3)} +{" "}
                  {hrCalibrationFitResult.slope.toFixed(4)} × heart rate, R² = {hrCalibrationFitResult.rSquared.toFixed(2)},
                  from {hrCalibrationFitResult.pointCount} points across {hrCalibrationFitResult.raceCount} run
                  {hrCalibrationFitResult.raceCount === 1 ? "" : "s"}.
                </p>
                {hrCalibrationFitResult.rSquared < MIN_HR_CALIBRATION_R_SQUARED && (
                  <p className="help danger">
                    R² is below {MIN_HR_CALIBRATION_R_SQUARED.toFixed(1)} -- heart rate doesn't track this athlete's effort
                    very reliably yet (or this is too little/noisy data). Not a bug: some athletes' HR just isn't a strong
                    effort proxy. Treat this calibration with real caution, or gather more runs with HR data.
                  </p>
                )}
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={() => onApplyHrCalibration(hrCalibrationFitResult.slope, hrCalibrationFitResult.intercept)}
                >
                  Apply calibration
                </button>
                <p className="help">
                  {hrCalibrationFitResult.rSquared >= MIN_HR_CALIBRATION_R_SQUARED
                    ? "Applied automatically -- R² cleared the bar for trusting HR as an effort proxy for this athlete."
                    : "Not applied automatically -- see the note above; you can still apply it manually if you trust it."}
                </p>
              </div>
            )}

            {pacingMarginFitResult && (
              <div className="lab__section">
                <h4 className="lab__title">Pacing margin: chosen effort vs. race length</h4>
                <p className="help">
                  How much of your fitted ceiling you actually hold, by race length -- fit from your confirmed races' own
                  heart rate. Drives the "Chosen pacing" number shown with your predicted finish time.
                </p>
                <p className="help">
                  Fit from {pacingMarginFitResult.raceCount} confirmed race{pacingMarginFitResult.raceCount === 1 ? "" : "s"}, spanning{" "}
                  {pacingMarginFitResult.minDurationHours.toFixed(1)}-{pacingMarginFitResult.maxDurationHours.toFixed(1)}h. Predictions
                  for a race outside that range are an extrapolation, not something any confirmed race actually tested.
                </p>
                <table className="lab-table">
                  <tbody>
                    {pacingMarginFitResult.perRace.map((p) => (
                      <tr key={p.name}>
                        <td>{p.name}</td>
                        <td className="muted">{p.durationHours.toFixed(2)}h</td>
                        <td className="muted">
                          {p.chosenTheta !== null ? `chosen ${(p.chosenTheta * 100).toFixed(0)}%` : "no HR data"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="help">Applied automatically -- {pacingMarginFitResult.raceCount} confirmed races cleared the minimum to fit this curve.</p>
              </div>
            )}

            {descentCapFitResult && (
              <div className="lab__section">
                <h4 className="lab__title">Descent speed cap: how fast you control a slope</h4>
                <p className="help">
                  The fastest you demonstrably descend at a given gradient, fitted as an envelope over every downhill
                  segment in your library -- the tightest curve that still allows what you have actually run. This is a
                  control limit, not an effort one: it is what stops a big power budget from implying a downhill speed
                  nobody could hold. The built-in default came from one other athlete's single 55 km ultra.
                </p>
                {descentCapFitResult.tier === "defaults" ? (
                  <p className="help">
                    NOT APPLIED -- only {(descentCapFitResult.totalDescentM / 1000).toFixed(1)} km of descent across{" "}
                    {descentCapFitResult.bandCount} gradient bands, below the{" "}
                    {(MIN_DESCENT_CAP_DISTANCE_M / 1000).toFixed(0)} km minimum. Using the built-in curve.
                  </p>
                ) : (
                  <>
                    <p className="help">
                      Fit from {(descentCapFitResult.totalDescentM / 1000).toFixed(0)} km of descent across{" "}
                      {descentCapFitResult.bandCount} gradient bands:{" "}
                      <strong>{paceFromMs(descentCapFitResult.curve.onsetSpeedMs)}/km at -10%</strong>, easing to{" "}
                      <strong>{paceFromMs(descentCapFitResult.curve.clampSpeedMs)}/km at -45%</strong>
                      {descentCapFitResult.bindingGradients.length > 0 && (
                        <>
                          {" "}
                          -- set by your descending at{" "}
                          {descentCapFitResult.bindingGradients
                            .map((g) => `${(g * 100).toFixed(0)}%`)
                            .join(", ")}
                          .
                        </>
                      )}
                    </p>
                    {descentCapFitResult.tier === "onsetOnly" && (
                      <p className="help">
                        Only {(descentCapFitResult.steepDescentM / 1000).toFixed(1)} km of your descending is steeper than
                        -20%, which is not enough to measure the steep end independently -- it is carried at the default
                        curve's shape. Run more genuinely steep downhill to pin it down.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {durationCeilingFitResult && (
              <div className="lab__section">
                <h4 className="lab__title">Duration ceiling: how hard you can go, by race length</h4>
                <p className="help">
                  The upper bound on sustainable effort as a function of race duration, fit as an envelope over your
                  confirmed races -- the tightest curve that no race of yours sits above. Drives the "Theoretical ceiling"
                  finish time.
                </p>
                {durationCeilingFitResult.tier === "defaults" ? (
                  <p className="help">
                    NOT APPLIED (needs at least {MIN_DURATION_CEILING_RACES} confirmed races; had{" "}
                    {durationCeilingFitResult.raceCount}) -- using the built-in default curve.
                  </p>
                ) : (
                  <>
                    <p className="help">
                      Fit from {durationCeilingFitResult.raceCount} confirmed races:{" "}
                      {(durationCeilingFitResult.fraction60Min * 100).toFixed(1)}% of VO2max sustainable for an hour,
                      falling with an exponent of {durationCeilingFitResult.exponent.toFixed(3)}.
                      {durationCeilingFitResult.bindingRaceNames.length > 0 && (
                        <> Your ceiling rests on {durationCeilingFitResult.bindingRaceNames.join(" and ")}.</>
                      )}
                    </p>
                    {durationCeilingFitResult.tier === "anchorOnly" && (
                      <p className="help">
                        Your races are too close together in duration (longest / shortest ={" "}
                        {durationCeilingFitResult.durationSpanRatio.toFixed(1)}x, want at least{" "}
                        {MIN_DURATION_CEILING_SPAN_RATIO}x) to tell how steeply the curve falls, so the shape is held at the
                        default and only its height is fit. Confirm a race of a very different length to pin the shape down.
                      </p>
                    )}
                    {anaerobicFitResult && (
                      <p className="help">
                        {anaerobicFitResult.identifiable
                          ? `Short-race (anaerobic) capacity fit to ${anaerobicFitResult.anaerobicCapacityMin.toFixed(1)} min of W'/CP.`
                          : `Short-race (anaerobic) capacity left at its default -- your shortest confirmed race (${anaerobicFitResult.shortestRaceMin?.toFixed(0) ?? "?"} min) is long enough that your aerobic curve alone already explains it. Confirm a race under ~15 minutes to measure this.`}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {hrCalibrationFitResult &&
              (() => {
                const maxAerobic = maxAerobicPower(0, ceilingParams);
                if (!(maxAerobic > 0)) return null;
                const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
                const labAnchors: { label: string; enteredHr: number; powerWPerKg: number }[] = [];
                if (formInputs.lt1HeartRateBpm !== null) {
                  labAnchors.push({ label: "LT1", enteredHr: formInputs.lt1HeartRateBpm, powerWPerKg: lt1Fraction * maxAerobic });
                }
                if (formInputs.lt2HeartRateBpm !== null) {
                  labAnchors.push({ label: "LT2", enteredHr: formInputs.lt2HeartRateBpm, powerWPerKg: lt2Fraction * maxAerobic });
                }
                if (labAnchors.length === 0) return null;
                return (
                  <div className="lab__section">
                    <h4 className="lab__title">Derived vs. entered heart rate</h4>
                    <p className="help">Checks whether the calibration above agrees with your entered LT1/LT2 heart rate.</p>
                    <ul className="help lab-list">
                      {labAnchors.map((a) => {
                        const derivedHr = predictHeartRateFromPower(a.powerWPerKg, hrCalibrationFitResult);
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
              <div className="lab__section">
                <h4 className="lab__title">HR-effort calibration: from your LT1/LT2/fat-ox thresholds</h4>
                <p className="help">
                  Same mapping as above, but fit from your lab-measured LT1/LT2/fat-ox thresholds instead of training runs.
                </p>
                <p className="help">
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
                  className="button-ghost button-small"
                  onClick={() => onApplyHrCalibration(thresholdHrCalibrationFitResult.slope, thresholdHrCalibrationFitResult.intercept)}
                >
                  Apply calibration
                </button>
                <p className="help">
                  Not applied automatically -- lab data is trustworthy but usually just a handful of points; compare it
                  against your training-history calibration above before choosing one to apply.
                </p>
              </div>
            )}

            <button type="button" className="button-ghost button-danger" onClick={() => void clearAll()} disabled={clearing}>
              {clearing ? "Clearing…" : "Delete all stored runs"}
            </button>
          </div>
        </details>
      )}
    </>
  );
}
