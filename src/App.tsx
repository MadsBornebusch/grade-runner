import { useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "./gpx/pipeline";
import { runPipeline } from "./gpx/pipeline";
import { findSustainableTheta, type SolverInputs } from "./model/solver";
import { GpxUpload } from "./ui/GpxUpload";
import { InputsPanel } from "./ui/InputsPanel";
import { ElevationProfileChart } from "./ui/ElevationProfileChart";
import { FuelChart } from "./ui/FuelChart";
import { SplitTable } from "./ui/SplitTable";
import { ResultsSummary } from "./ui/ResultsSummary";
import { buildChartPoints } from "./ui/chartData";
import { loadFormInputs, saveFormInputs, substrateAnchorsFromThresholds } from "./ui/formInputs";
import "./App.css";

type AppMode = "planning" | "analysis";

function App() {
  const [mode, setMode] = useState<AppMode>("planning");
  const [rawPoints, setRawPoints] = useState<GpxPoint[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());

  useEffect(() => {
    saveFormInputs(formInputs);
  }, [formInputs]);

  const courseResult = useMemo(() => {
    if (!rawPoints) return null;
    return runPipeline(rawPoints, {
      segmentLengthM: formInputs.segmentLengthM,
      smoothingWindowM: formInputs.smoothingWindowM,
    });
  }, [rawPoints, formInputs.segmentLengthM, formInputs.smoothingWindowM]);

  const solverInputs = useMemo<SolverInputs | null>(() => {
    if (!courseResult || courseResult.segments.length === 0) return null;
    const { x0, k } = substrateAnchorsFromThresholds(formInputs.lt1Fraction, formInputs.lt2Fraction);
    return {
      segments: courseResult.segments,
      bodyMassKg: formInputs.bodyMassKg,
      ceilingParams: {
        vo2MaxMlPerKgPerMin: formInputs.vo2MaxMlPerKgPerMin,
        lt2Fraction: formInputs.lt2Fraction,
        f0: formInputs.f0,
        fInf: formInputs.fInf,
        tauMin: formInputs.tauMin,
        durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
      },
      substrateParams: { x0, k, foPeakGPerMin: formInputs.foPeakGPerMin },
      fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
      glycogenStoreG: formInputs.glycogenStoreG,
      reserveG: formInputs.reserveG,
      walkMaxMs: formInputs.walkMaxMs,
      forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
      altitudeAdjustment: formInputs.altitudeAdjustment,
    };
  }, [courseResult, formInputs]);

  const solverResult = useMemo(() => {
    if (!solverInputs) return null;
    return findSustainableTheta(solverInputs);
  }, [solverInputs]);

  const chartPoints = useMemo(() => {
    if (!courseResult || !solverResult) return [];
    return buildChartPoints(courseResult.segments, solverResult.result.segments);
  }, [courseResult, solverResult]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Grade Runner</h1>
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === "planning" ? "active" : ""}
            onClick={() => setMode("planning")}
          >
            Planning
          </button>
          <button
            type="button"
            className={mode === "analysis" ? "active" : ""}
            onClick={() => setMode("analysis")}
          >
            Analysis
          </button>
        </div>
      </header>

      {mode === "analysis" ? (
        <p className="placeholder">Analysis mode is coming soon.</p>
      ) : (
        <div className="app__layout">
          <aside className="app__sidebar">
            <GpxUpload
              onLoaded={(points, name) => {
                setRawPoints(points);
                setFileName(name);
              }}
            />
            <InputsPanel values={formInputs} onChange={setFormInputs} />
          </aside>

          <main className="app__main">
            {!courseResult && <p className="placeholder">Upload a course GPX to get started.</p>}

            {courseResult && (
              <>
                {fileName && <p className="course-name">{fileName}</p>}
                {!courseResult.hasElevation && (
                  <p className="warning">No elevation data found — treating the course as flat.</p>
                )}
                <p className="course-stats">
                  {(courseResult.totalDistance3D / 1000).toFixed(1)} km &middot;{" "}
                  {courseResult.totalElevationGain.toFixed(0)} m gain
                </p>

                {solverResult && (
                  <>
                    <ResultsSummary
                      theta={solverResult.theta}
                      result={solverResult.result}
                      totalDistanceM={courseResult.totalDistance3D}
                    />
                    <ElevationProfileChart points={chartPoints} />
                    <FuelChart points={chartPoints} reserveG={formInputs.reserveG} />
                    <SplitTable points={chartPoints} />
                  </>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

export default App;
