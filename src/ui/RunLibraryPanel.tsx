import { useCallback, useEffect, useState } from "react";
import { parseGpx, runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import { buildEffortTrendPoints, fitTauAcrossRaces, type MultiRaceTauFitResult } from "../model/pacingFit";
import { addStoredRun, deleteStoredRun, listStoredRuns, type StoredRun } from "../storage/runLibrary";
import type { FormInputs } from "./formInputs";

interface RunLibraryPanelProps {
  formInputs: FormInputs;
  onApplyTau: (tauMin: number) => void;
}

/** Distance/duration summary for the run list -- cheap, so recomputed on
 * every render rather than cached alongside the stored points. */
function summarize(points: StoredRun["points"]) {
  const course = runPipeline(points);
  const durationH = course.hasTimestamps
    ? course.segments.reduce((sum, s) => sum + (s.dtS ?? 0), 0) / 3600
    : null;
  return { distanceKm: course.totalDistance3D / 1000, durationH, hasTimestamps: course.hasTimestamps };
}

export function RunLibraryPanel({ formInputs, onApplyTau }: RunLibraryPanelProps) {
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<MultiRaceTauFitResult | null>(null);
  const [fitRan, setFitRan] = useState(false);

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

  const ceilingParams = {
    vo2MaxMlPerKgPerMin: formInputs.vo2MaxMlPerKgPerMin,
    lt2Fraction: formInputs.lt2Fraction,
    f0: formInputs.f0,
    fInf: formInputs.fInf,
    tauMin: formInputs.tauMin,
    durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
  };

  const runFit = () => {
    const races = runs
      .filter((r) => selected.has(r.id))
      .map((r) => {
        const course = runPipeline(r.points);
        if (!course.hasTimestamps) return null;
        const analysis = analyzeRun(course.segments, {
          bodyMassKg: formInputs.bodyMassKg,
          ceilingParams,
          fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
          glycogenStoreG: formInputs.glycogenStoreG,
          reserveG: formInputs.reserveG,
          walkMaxMs: formInputs.walkMaxMs,
          altitudeAdjustment: formInputs.altitudeAdjustment,
        });
        return buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    setFitResult(fitTauAcrossRaces(races, ceilingParams));
    setFitRan(true);
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
      {error && <p className="gpx-upload__error">{error}</p>}

      {runs.length === 0 && <p className="placeholder">No runs stored yet.</p>}

      {runs.length > 0 && (
        <div className="fatox-rows">
          {runs.map((run) => {
            const summary = summarize(run.points);
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
        <button type="button" className="fatox-add" onClick={runFit} disabled={selectedCount === 0}>
          Fit tau from {selectedCount} selected run{selectedCount === 1 ? "" : "s"}
        </button>
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
          <ul>
            {fitResult.perRace.map((race, i) => (
              <li key={i} className="field-group-note">
                Run {i + 1}: {race.trendAtCurrentPctPerHour >= 0 ? "+" : ""}
                {race.trendAtCurrentPctPerHour.toFixed(1)}%/hour &rarr;{" "}
                {race.trendAtFitPctPerHour >= 0 ? "+" : ""}
                {race.trendAtFitPctPerHour.toFixed(1)}%/hour at the fitted tau.
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
