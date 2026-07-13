import { useCallback, useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import {
  buildEffortTrendPoints,
  fitTauAcrossRaces,
  fitTauMinutes,
  type EffortTrendPoint,
  type MultiRaceTauFitResult,
} from "../model/pacingFit";
import { suggestRunsForFit } from "../model/suggestRuns";
import { dedupeStoredRuns } from "../model/dedupeRuns";
import { filterRunsSinceDate, shouldFetchNextBackfillPage, toStoredRunSummaryInput, type BackfillPage } from "../model/stravaBackfill";
import { computeTauDiagnostic, type RaceDiagnosticPoint } from "../model/tauDiagnostic";
import { descentImpact, descentImpactSquared } from "../model/descentImpact";
import { estimateVo2MaxFromRun } from "../model/vo2MaxEstimate";
import {
  addStoredRun,
  clearStoredRuns,
  deleteStoredRun,
  listStoredRuns,
  setStoredRunPoints,
  upsertStoredRunSummary,
  type StoredRun,
} from "../storage/runLibrary";
import { resolveVo2Max, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { fetchStravaActivity } from "./stravaClient";
import { useStravaSession } from "./useStravaSession";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
}

const BACKFILL_MAX_PAGES = 50;
const BACKFILL_PER_PAGE = 100;
const BACKFILL_PAGE_DELAY_MS = 300;
/** Above this many summary-only runs selected for a fit, fetching full GPS
 * data would mean too many Strava API calls to do inline -- see PLAN.md §12. */
const MAX_LAZY_FETCH = 8;

const DEFAULT_HALF_LIFE_DAYS = 75;
/** Only the strongest few estimates are shown -- see vo2MaxEstimates below
 * for why sorting by estimate descending is itself the intensity filter. */
const MAX_VO2MAX_ESTIMATES_SHOWN = 3;

function oneYearAgoDateInput(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** A run's own calendar date, for recency-weighting the multi-race fit --
 * Strava summaries carry it directly; GPX-derived runs (manual upload, or a
 * Strava run whose points have already been fetched) fall back to the
 * first point's own timestamp. Null if neither is available. */
function runDate(run: StoredRun): Date | null {
  if (run.date) return new Date(run.date);
  const firstPointTime = run.points?.[0]?.time;
  return firstPointTime ?? null;
}

/** Summary-only rows (points === null) read their distance/duration
 * straight off the stored Strava summary -- no pipeline run needed, and
 * it's the only data available anyway until points are fetched. Rows with
 * full points (manual uploads, or already-fetched Strava runs) still go
 * through the pipeline, since that's the only source of truth for those. */
function summarize(run: StoredRun) {
  if (run.points === null) {
    return {
      distanceKm: run.distanceKm ?? 0,
      durationH: run.durationS !== undefined ? run.durationS / 3600 : null,
      hasTimestamps: run.durationS !== undefined,
    };
  }
  const course = runPipeline(run.points);
  const durationH = course.hasTimestamps
    ? course.segments.reduce((sum, s) => sum + (s.dtS ?? 0), 0) / 3600
    : null;
  return { distanceKm: course.totalDistance3D / 1000, durationH, hasTimestamps: course.hasTimestamps };
}

export function RunLibraryPanel({ formInputs, onApplyTau, onAddVo2MaxEntry }: RunLibraryPanelProps) {
  const { connected: stravaConnected } = useStravaSession();
  const [runs, setRuns] = useState<StoredRun[]>([]);
  // Runs with full GPS data already downloaded (points !== null) are selected
  // for the fit by default -- no manual scrolling/checking needed for the
  // common case. This map only records *departures* from that default (a
  // user unchecking a fetched run, or opting a summary-only one in).
  const [selectionOverrides, setSelectionOverrides] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<MultiRaceTauFitResult | null>(null);
  const [fitRan, setFitRan] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [halfLifeDays, setHalfLifeDays] = useState(DEFAULT_HALF_LIFE_DAYS);

  const [backfillFrom, setBackfillFrom] = useState(oneYearAgoDateInput);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<string | null>(null);

  const [deselectedSuggestionIds, setDeselectedSuggestionIds] = useState<Set<string>>(new Set());
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

  const isSelected = useCallback(
    (run: StoredRun) => selectionOverrides.get(run.id) ?? run.points !== null,
    [selectionOverrides],
  );

  const toggleSelected = (run: StoredRun) => {
    setSelectionOverrides((prev) => {
      const next = new Map(prev);
      next.set(run.id, !isSelected(run));
      return next;
    });
  };

  const remove = async (id: string) => {
    await deleteStoredRun(id);
    setSelectionOverrides((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    refresh();
  };

  const [clearing, setClearing] = useState(false);
  const clearAll = async () => {
    if (!window.confirm("Delete every stored run? This clears the whole local run library and can't be undone.")) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      await clearStoredRuns();
      setSelectionOverrides(new Map());
      setFitResult(null);
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

  const ceilingParams = {
    vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory),
    lt2Fraction: formInputs.lt2Fraction,
    f0: formInputs.f0,
    fInf: formInputs.fInf,
    tauMin: formInputs.tauMin,
    durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
  };

  // PLAN.md §12 stage 4 / §13: does descent load (or generic intensity)
  // actually predict this athlete's own tau? Only races with full points
  // already fetched are included -- no new Strava calls triggered just to
  // populate a diagnostic. Races whose own single-race fit hit a search
  // boundary are excluded too (an unreliable estimate would just add noise).
  const tauDiagnostic = useMemo(() => {
    const diagnosticCeilingParams = {
      vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory),
      lt2Fraction: formInputs.lt2Fraction,
      f0: formInputs.f0,
      fInf: formInputs.fInf,
      tauMin: formInputs.tauMin,
      durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
    };
    const points: RaceDiagnosticPoint[] = [];
    for (const run of dedupedRuns) {
      if (run.points === null) continue;
      const course = runPipeline(run.points);
      if (!course.hasTimestamps) continue;
      const analysis = analyzeRun(course.segments, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams: diagnosticCeilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
        glycogenStoreG: formInputs.glycogenStoreG,
        reserveG: formInputs.reserveG,
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      });
      const effortTrendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      const tauFit = fitTauMinutes(effortTrendPoints, diagnosticCeilingParams);
      if (!tauFit || tauFit.hitSearchBoundary) continue;
      const distanceKm = course.totalDistance3D / 1000;
      if (distanceKm <= 0) continue;
      points.push({
        label: run.name,
        tauMin: tauFit.tauMin,
        avgIntensity: analysis.avgEffortFraction,
        descentPerKm: course.totalElevationLoss / distanceKm,
        descentImpactPerKm: descentImpact(course.segments) / distanceKm,
        descentImpactSquaredPerKm: descentImpactSquared(course.segments) / distanceKm,
      });
    }
    return computeTauDiagnostic(points);
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
    const estimateCeilingParams = {
      vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory),
      lt2Fraction: formInputs.lt2Fraction,
      f0: formInputs.f0,
      fInf: formInputs.fInf,
      tauMin: formInputs.tauMin,
      durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
    };
    const results: { run: StoredRun; estimateMlPerKgPerMin: number }[] = [];
    for (const run of dedupedRuns) {
      if (run.points === null) continue;
      const course = runPipeline(run.points);
      if (!course.hasTimestamps) continue;
      const analysis = analyzeRun(course.segments, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams: estimateCeilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
        glycogenStoreG: formInputs.glycogenStoreG,
        reserveG: formInputs.reserveG,
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

  const runFit = async () => {
    const selectedRuns = dedupedRuns.filter(isSelected);
    const unfetchedCount = selectedRuns.filter((r) => r.points === null).length;
    if (unfetchedCount > MAX_LAZY_FETCH) {
      const estimatedMinutes = Math.ceil((unfetchedCount * 2 * 9) / 60);
      setError(
        `${unfetchedCount} selected runs don't have their full GPS data yet -- fetching all of them would take ` +
          `roughly ${estimatedMinutes} minutes and a large share of Strava's daily rate limit. Narrow your ` +
          `selection to ${MAX_LAZY_FETCH} or fewer summary-only runs (try the suggested runs below, or the ` +
          `filters in the Strava import panel), then fit again.`,
      );
      return;
    }

    setFitting(true);
    setError(null);
    try {
      const races: EffortTrendPoint[][] = [];
      const raceDates: (Date | null)[] = [];
      for (const run of selectedRuns) {
        const points = await ensurePoints(run);
        const course = runPipeline(points);
        if (!course.hasTimestamps) continue;
        const analysis = analyzeRun(course.segments, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
          glycogenStoreG: formInputs.glycogenStoreG,
          reserveG: formInputs.reserveG,
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        races.push(buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment));
        raceDates.push(runDate(run));
      }
      setFitResult(fitTauAcrossRaces(races, ceilingParams, { raceDates, halfLifeDays }));
      setFitRan(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fit failed.");
    } finally {
      setFitting(false);
    }
  };

  const suggestions = useMemo(() => suggestRunsForFit(dedupedRuns), [dedupedRuns]);
  const approvedSuggestions = useMemo(() => {
    // A run can appear in more than one bucket (e.g. the single longest run
    // is both a durability and a duration-spread candidate) -- dedupe by id
    // before fetching, so it isn't counted or fetched twice.
    const byId = new Map(
      [...suggestions.vo2max, ...suggestions.durability, ...suggestions.durationSpread]
        .filter((r) => !deselectedSuggestionIds.has(r.id))
        .map((r) => [r.id, r]),
    );
    return [...byId.values()];
  }, [suggestions, deselectedSuggestionIds]);

  const fetchApprovedSuggestions = async () => {
    setFetchingSuggestions(true);
    setError(null);
    try {
      for (const run of approvedSuggestions) {
        await ensurePoints(run);
      }
      setDeselectedSuggestionIds(new Set());
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch suggested runs.");
    } finally {
      setFetchingSuggestions(false);
    }
  };

  const toggleSuggestion = (id: string) => {
    setDeselectedSuggestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCount = dedupedRuns.filter(isSelected).length;

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
        selected race's own effort trend simultaneously, not just one run's idiosyncrasies. It doesn't separately
        identify f0 or fInf: that needs races spanning a much wider range of durations than a typical library, plus
        an anchor on the ceiling's absolute level that this fit doesn't have. Runs without a recorded timestamp can't
        be used here. Runs with full GPS data already downloaded are selected for the fit automatically -- uncheck
        any you want to leave out.
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

      {(suggestions.vo2max.length > 0 ||
        suggestions.durability.length > 0 ||
        suggestions.durationSpread.length > 0) && (
        <div className="run-library__suggestions">
          <p className="field-group-help">
            Suggested from the summaries above -- short, high-intensity runs are what actually constrains VO2max;
            your longest runs are what the fatigue-fade fit (and stage 5's diagnostic) need; a few runs spanning a
            wide duration range prep for a future joint fit (see PLAN.md §12). Uncheck any you don't want, then
            fetch full data for the rest.
          </p>
          {suggestions.vo2max.length > 0 && (
            <>
              <p className="field-group-note">Likely hard efforts (VO2max):</p>
              <div className="fatox-rows">
                {suggestions.vo2max.map((run) => (
                  <label key={run.id} className="run-library-row">
                    <input
                      type="checkbox"
                      checked={!deselectedSuggestionIds.has(run.id)}
                      onChange={() => toggleSuggestion(run.id)}
                    />
                    <span className="run-library-row__label">
                      {run.name} &middot; {(run.distanceKm ?? 0).toFixed(1)} km &middot;{" "}
                      {((run.durationS ?? 0) / 60).toFixed(0)} min
                      {run.avgWatts ? ` · ${run.avgWatts.toFixed(0)} W avg` : ""}
                      {!run.avgWatts && run.avgHeartRate ? ` · ${run.avgHeartRate.toFixed(0)} bpm avg` : ""}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {suggestions.durability.length > 0 && (
            <>
              <p className="field-group-note">Longest runs (durability + stage-5 diagnostic):</p>
              <div className="fatox-rows">
                {suggestions.durability.map((run) => (
                  <label key={run.id} className="run-library-row">
                    <input
                      type="checkbox"
                      checked={!deselectedSuggestionIds.has(run.id)}
                      onChange={() => toggleSuggestion(run.id)}
                    />
                    <span className="run-library-row__label">
                      {run.name} &middot; {(run.distanceKm ?? 0).toFixed(1)} km &middot;{" "}
                      {((run.durationS ?? 0) / 3600).toFixed(1)} h
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {suggestions.durationSpread.length > 0 && (
            <>
              <p className="field-group-note">Duration spread (prep for a future joint f0/fInf/tau fit):</p>
              <p className="field-group-help">
                That fit isn't buildable yet -- it also needs a level-anchor term this app doesn't have (PLAN.md
                §11) -- but it'll need races spanning a wide duration range once it exists, so it's worth having
                these on hand already.
              </p>
              <div className="fatox-rows">
                {suggestions.durationSpread.map((run) => (
                  <label key={run.id} className="run-library-row">
                    <input
                      type="checkbox"
                      checked={!deselectedSuggestionIds.has(run.id)}
                      onChange={() => toggleSuggestion(run.id)}
                    />
                    <span className="run-library-row__label">
                      {run.name} &middot; {(run.distanceKm ?? 0).toFixed(1)} km &middot;{" "}
                      {((run.durationS ?? 0) / 3600).toFixed(1)} h
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="fatox-add"
            onClick={() => void fetchApprovedSuggestions()}
            disabled={fetchingSuggestions || approvedSuggestions.length === 0}
          >
            {fetchingSuggestions
              ? "Fetching…"
              : `Fetch ${approvedSuggestions.length} approved run${approvedSuggestions.length === 1 ? "" : "s"}`}
          </button>
        </div>
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
        <div className="fatox-rows">
          {dedupedRuns.map((run) => {
            const summary = summarize(run);
            return (
              <div key={run.id} className="run-library-row">
                <input
                  type="checkbox"
                  checked={isSelected(run)}
                  disabled={!summary.hasTimestamps}
                  onChange={() => toggleSelected(run)}
                />
                <span className="run-library-row__label">
                  {run.name} &middot; {summary.distanceKm.toFixed(1)} km
                  {summary.durationH !== null && ` · ${summary.durationH.toFixed(1)} h`}
                  {!summary.hasTimestamps && " (no timestamps -- can't be used for a tau fit)"}
                  {run.points === null && summary.hasTimestamps && " (summary only)"}
                </span>
                <button type="button" className="fatox-row__remove" onClick={() => remove(run.id)} aria-label="Remove run">
                  ×
                </button>
              </div>
            );
          })}
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
            <span>days -- older selected runs count for less</span>
          </div>
          <button type="button" className="fatox-add" onClick={() => void runFit()} disabled={selectedCount === 0 || fitting}>
            {fitting ? "Fitting…" : `Fit tau from ${selectedCount} selected run${selectedCount === 1 ? "" : "s"}`}
          </button>
        </>
      )}

      {fitRan && !fitResult && (
        <p className="warning">
          Not enough moving time across the selected runs to fit a trend -- select longer recordings, or more of
          them.
        </p>
      )}

      {fitResult && (
        <>
          <p className="field-group-note">
            Best-fit tau across {fitResult.perRace.length} run{fitResult.perRace.length === 1 ? "" : "s"}: {fitResult.tauMin} min.
          </p>
          <ul className="run-library__fit-notes">
            {fitResult.perRace.map((race, i) => (
              <li key={i} className={race.unresponsive ? "warning" : "field-group-note"}>
                Run {i + 1}: {race.trendAtCurrentPctPerHour >= 0 ? "+" : ""}
                {race.trendAtCurrentPctPerHour.toFixed(1)}%/hour &rarr;{" "}
                {race.trendAtFitPctPerHour >= 0 ? "+" : ""}
                {race.trendAtFitPctPerHour.toFixed(1)}%/hour at the fitted tau.
                {race.unresponsive &&
                  " This run's own duration is too short (or too long) relative to the fitted tau for its modeled ceiling to move at all -- it had no real say in this result. Consider unchecking it and re-fitting."}
              </li>
            ))}
          </ul>
          <button type="button" className="fatox-add" onClick={() => onApplyTau(fitResult.tauMin)}>
            Apply tau = {fitResult.tauMin} min
          </button>
          {fitResult.hitSearchBoundary && (
            <p className="field-group-note">
              This landed at the {fitResult.hitSearchBoundary} edge of the search range -- treat it as a bound, not a
              precise value. The true tau may be even{" "}
              {fitResult.hitSearchBoundary === "upper" ? "larger (a slower fade)" : "smaller (a faster fade)"}.
            </p>
          )}
        </>
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
    </div>
  );
}
