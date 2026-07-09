import { useCallback, useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import { buildEffortTrendPoints, fitTauAcrossRaces, type EffortTrendPoint, type MultiRaceTauFitResult } from "../model/pacingFit";
import { suggestRunsForFit } from "../model/suggestRuns";
import { filterRunsSinceDate, shouldFetchNextBackfillPage, toStoredRunSummaryInput, type BackfillPage } from "../model/stravaBackfill";
import {
  addStoredRun,
  deleteStoredRun,
  listStoredRuns,
  setStoredRunPoints,
  upsertStoredRunSummary,
  type StoredRun,
} from "../storage/runLibrary";
import { resolveVo2Max, type FormInputs } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { fetchStravaActivity } from "./stravaClient";
import { useStravaSession } from "./useStravaSession";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
}

const BACKFILL_MAX_PAGES = 50;
const BACKFILL_PER_PAGE = 100;
const BACKFILL_PAGE_DELAY_MS = 300;
/** Above this many summary-only runs selected for a fit, fetching full GPS
 * data would mean too many Strava API calls to do inline -- see PLAN.md §12. */
const MAX_LAZY_FETCH = 8;

const DEFAULT_HALF_LIFE_DAYS = 75;

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

export function RunLibraryPanel({ formInputs, onApplyTau }: RunLibraryPanelProps) {
  const { connected: stravaConnected } = useStravaSession();
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async (id: string) => {
    await deleteStoredRun(id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    refresh();
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
    const selectedRuns = runs.filter((r) => selected.has(r.id));
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

  const suggestions = useMemo(() => suggestRunsForFit(runs), [runs]);
  const approvedSuggestions = useMemo(() => {
    // A run can appear in both lists (e.g. a short library with nothing
    // truly long) -- dedupe by id before fetching.
    const byId = new Map(
      [...suggestions.vo2max, ...suggestions.durability]
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

  const selectedCount = selected.size;

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Run library</h3>
      </div>
      <p className="field-group-help">
        Store past runs here and fit one shared fade time constant (tau) across several of them at once, instead of
        just this course's recording. Pooling races is mainly about robustness -- one tau has to flatten every
        selected race's own effort trend simultaneously, not just one run's idiosyncrasies. It doesn't separately
        identify f0 or fInf: that needs races spanning a much wider range of durations than a typical library, plus
        an anchor on the ceiling's absolute level that this fit doesn't have. Runs without a recorded timestamp can't
        be used here.
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

      {(suggestions.vo2max.length > 0 || suggestions.durability.length > 0) && (
        <div className="run-library__suggestions">
          <p className="field-group-help">
            Suggested from the summaries above -- short, high-intensity runs are what actually constrains VO2max;
            your longest runs are what the fatigue-fade fit needs (see PLAN.md §12). Uncheck any you don't want,
            then fetch full data for the rest.
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
              <p className="field-group-note">Longest runs (durability):</p>
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

      {runs.length === 0 && <p className="placeholder">No runs stored yet.</p>}

      {runs.length > 0 && (
        <div className="fatox-rows">
          {runs.map((run) => {
            const summary = summarize(run);
            return (
              <div key={run.id} className="run-library-row">
                <input
                  type="checkbox"
                  checked={selected.has(run.id)}
                  disabled={!summary.hasTimestamps}
                  onChange={() => toggleSelected(run.id)}
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

      {runs.length > 0 && (
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
    </div>
  );
}
