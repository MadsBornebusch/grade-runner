import { useCallback, useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  fitSurfaceDriftAcrossRaces,
  fitTauFInfWithSupportGate,
  MIN_INFORMATIVE_RACES,
  suggestFitImprovements,
  type EffortTrendPoint,
  type FInfTauFitResult,
  type MultiRaceSurfaceDriftFitResult,
  type MultiRaceTauFitResult,
  type SafeFitResult,
  type TauConfidenceInterval,
} from "../model/pacingFit";
import { suggestRunsForFit } from "../model/suggestRuns";
import { dedupeStoredRuns } from "../model/dedupeRuns";
import { attachSurfaceData } from "../model/surfaceExposure";
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
import { resolveCeilingParams, resolveGlycogenStoreG, type FormInputs, type Vo2MaxEntry } from "./formInputs";
import { StravaImport } from "./StravaImport";
import { fetchStravaActivity } from "./stravaClient";
import { fetchSurfaceEdges } from "./surfaceLookup";
import { useStravaSession } from "./useStravaSession";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
  onApplyFInf: (fInf: number) => void;
  onApplySurfaceDrift: (durabilityDriftPerUnpavedUnit: number) => void;
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

export function RunLibraryPanel({
  formInputs,
  onApplyTau,
  onApplyFInf,
  onApplySurfaceDrift,
  onAddVo2MaxEntry,
  onRacesFitted,
}: RunLibraryPanelProps) {
  const { connected: stravaConnected } = useStravaSession();
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<MultiRaceTauFitResult | null>(null);
  const [fInfFitResult, setFInfFitResult] = useState<FInfTauFitResult | null>(null);
  const [surfaceDriftFitResult, setSurfaceDriftFitResult] = useState<MultiRaceSurfaceDriftFitResult | null>(null);
  const [safeFitTier, setSafeFitTier] = useState<SafeFitResult["tier"] | null>(null);
  const [fitRan, setFitRan] = useState(false);
  const [fitting, setFitting] = useState(false);
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
      setSurfaceDriftFitResult(null);
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

  // PLAN.md §12 stage 4 / §13: does descent load (or generic intensity)
  // actually predict this athlete's own tau? Only races with full points
  // already fetched are included -- no new Strava calls triggered just to
  // populate a diagnostic. Races whose own single-race fit hit a search
  // boundary are excluded too (an unreliable estimate would just add noise).
  const tauDiagnostic = useMemo(() => {
    const diagnosticCeilingParams = resolveCeilingParams(formInputs);
    const points: RaceDiagnosticPoint[] = [];
    for (const run of dedupedRuns) {
      if (run.points === null) continue;
      const course = runPipeline(run.points);
      const point = buildRaceDiagnosticPoint(run.name, course, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams: diagnosticCeilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      });
      if (point) points.push(point);
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
      if (run.points === null) continue;
      const course = runPipeline(run.points);
      const point = buildWithinRaceDiagnosticPoint(run.name, course, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams: diagnosticCeilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      });
      if (point) points.push(point);
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
    // Automatic: every stored run with full GPS data already fetched joins
    // the fit, no manual curation -- runs still summary-only (backfilled but
    // not fetched) are simply left out until fetched via the suggestions
    // below or a direct import.
    const readyRuns = dedupedRuns.filter((r) => r.points !== null);

    setFitting(true);
    setError(null);
    try {
      const races: EffortTrendPoint[][] = [];
      const raceDates: (Date | null)[] = [];
      for (const run of readyRuns) {
        const points = await ensurePoints(run);
        const course = runPipeline(points);
        if (!course.hasTimestamps) continue;
        const surfaceEdges = await ensureSurfaceData(run, points);
        const segments = surfaceEdges ? attachSurfaceData(course.segments, surfaceEdges) : course.segments;
        const analysis = analyzeRun(segments, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH },
          glycogenStoreG: resolveGlycogenStoreG(formInputs),
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        races.push(buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment));
        raceDates.push(runDate(run));
      }
      const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates, halfLifeDays });
      setFitResult(safeFit.tauFit);
      setFInfFitResult(safeFit.fInfFit);
      setSafeFitTier(safeFit.tier);

      // Surface drift is fit against the SAME (tau, fInf) this fit just
      // settled on, mirroring how the joint fit itself holds f0 fixed --
      // holding tau/fInf fixed here keeps this a one-more-axis addition,
      // not a simultaneous 3-parameter search this session's investigation
      // never validated. Auto-applies under the same support bar as the
      // tau-only tier (informative races, no boundary hit) -- there's no
      // "joint" equivalent to prefer instead, since this is the only fit
      // for this term.
      const surfaceDriftFit = fitSurfaceDriftAcrossRaces(races, safeFit.ceilingParams, { raceDates, halfLifeDays });
      setSurfaceDriftFitResult(surfaceDriftFit);
      if (
        surfaceDriftFit &&
        surfaceDriftFit.informativeRaceCount >= MIN_INFORMATIVE_RACES &&
        !surfaceDriftFit.hitSearchBoundary
      ) {
        onApplySurfaceDrift(surfaceDriftFit.durabilityDriftPerUnpavedUnit);
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
        timestamp is used automatically -- no manual curation needed.
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
          {fitResult.informativeRaceCount < MIN_INFORMATIVE_RACES && (
            <p className="warning">
              Only {fitResult.informativeRaceCount} of {fitResult.perRace.length} selected runs actually constrained
              this fit (see the unresponsive ones marked below) -- with fewer than {MIN_INFORMATIVE_RACES}, this isn't
              really a pooled result, it's effectively one run's own pacing labeled as a fit across many. Treat this
              tau with real caution, or select more runs of a genuinely different duration before applying it.
            </p>
          )}
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
            Fits fInf and tau together from the same selected runs above, holding VO2max and f0 fixed -- fixing f0 is
            what makes this well-posed rather than an unbounded search (verified with a synthetic recovery test, not
            just assumed). This does <strong>not</strong> independently verify VO2max or f0: fInf comes out relative
            to whatever those currently are, and absorbs error in both. Treat this as "the fit is runnable," not "fInf
            is now a trustworthy, independently-measured number."
          </p>
          <p className={fInfFitResult.durationDiversityRatio < 2 ? "warning" : "field-group-note"}>
            Duration range across selected races: {fInfFitResult.durationDiversityRatio.toFixed(1)}x (longest ÷
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
              Only {fInfFitResult.informativeRaceCount} of {fInfFitResult.perRace.length} selected runs actually
              constrained this fit -- with fewer than {MIN_INFORMATIVE_RACES}, "fInf {fInfFitResult.fInf.toFixed(2)},
              tau {fInfFitResult.tauMin}min" is really just one run's own pacing, not a genuine multi-race result.
              Select more runs of a different duration before applying either value.
            </p>
          )}
          <ul className="run-library__fit-notes">
            {fInfFitResult.perRace.map((race, i) => (
              <li key={i} className={race.unresponsive ? "warning" : "field-group-note"}>
                Run {i + 1}: {race.trendAtCurrentPctPerHour >= 0 ? "+" : ""}
                {race.trendAtCurrentPctPerHour.toFixed(1)}%/hour &rarr;{" "}
                {race.trendAtFitPctPerHour >= 0 ? "+" : ""}
                {race.trendAtFitPctPerHour.toFixed(1)}%/hour at the fitted (fInf, tau).
                {race.unresponsive && " Too short (or too long) relative to the fit for its ceiling to move -- no real say in this result."}
              </li>
            ))}
          </ul>
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

      {surfaceDriftFitResult && (
        <div className="run-library__experimental-fit">
          <p className="field-group-note">Terrain surface drift</p>
          <p className="field-group-help">
            Fraction of ceiling lost per meter of unpaved/technical trail surface covered, on top of the tau/fInf fade
            above -- fetched via a public OpenStreetMap map-matching lookup per run (fails silently and just leaves a
            run out if that lookup doesn't succeed). Validated with a leave-one-out backtest across 31 real races: 28
            improved, 0 regressed when this term was added.
          </p>
          <p className="field-group-note">
            Best fit: {surfaceDriftFitResult.durabilityDriftPerUnpavedUnit.toExponential(3)} per unpaved meter, across{" "}
            {surfaceDriftFitResult.perRace.length} run{surfaceDriftFitResult.perRace.length === 1 ? "" : "s"} with
            surface data.
          </p>
          {surfaceDriftFitResult.informativeRaceCount < MIN_INFORMATIVE_RACES && (
            <p className="warning">
              Only {surfaceDriftFitResult.informativeRaceCount} of {surfaceDriftFitResult.perRace.length} runs with
              surface data actually had meaningful unpaved exposure to constrain this fit -- with fewer than{" "}
              {MIN_INFORMATIVE_RACES}, treat this rate with real caution.
            </p>
          )}
          <ul className="run-library__fit-notes">
            {surfaceDriftFitResult.perRace.map((race, i) => (
              <li key={i} className={race.unresponsive ? "warning" : "field-group-note"}>
                Run {i + 1}: {race.trendAtCurrentPctPerHour >= 0 ? "+" : ""}
                {race.trendAtCurrentPctPerHour.toFixed(1)}%/hour &rarr;{" "}
                {race.trendAtFitPctPerHour >= 0 ? "+" : ""}
                {race.trendAtFitPctPerHour.toFixed(1)}%/hour at the fitted rate.
                {race.unresponsive && " Little to no unpaved exposure recorded -- no real say in this result."}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="fatox-add"
            onClick={() => onApplySurfaceDrift(surfaceDriftFitResult.durabilityDriftPerUnpavedUnit)}
          >
            Apply rate = {surfaceDriftFitResult.durabilityDriftPerUnpavedUnit.toExponential(3)}
          </button>
          <p className="field-group-note">
            {surfaceDriftFitResult.informativeRaceCount >= MIN_INFORMATIVE_RACES && !surfaceDriftFitResult.hitSearchBoundary
              ? "Applied automatically -- enough informative runs, and stayed within its search range."
              : "Not applied automatically -- see the notes above; you can still apply it manually if you trust it."}
          </p>
          {surfaceDriftFitResult.hitSearchBoundary && (
            <p className="field-group-note">
              This landed at the {surfaceDriftFitResult.hitSearchBoundary} edge of the search range -- treat it as a
              bound, not a precise value.
            </p>
          )}
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
