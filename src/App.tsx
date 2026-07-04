import { useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "./gpx/pipeline";
import { runPipeline } from "./gpx/pipeline";
import { findSustainableTheta, type SolverInputs } from "./model/solver";
import { analyzeRun, type AnalysisInputs } from "./model/analysis";
import { GpxUpload } from "./ui/GpxUpload";
import { InputsPanel } from "./ui/InputsPanel";
import { ElevationProfileChart } from "./ui/ElevationProfileChart";
import { FuelChart } from "./ui/FuelChart";
import { SubstrateChart } from "./ui/SubstrateChart";
import { SplitTable } from "./ui/SplitTable";
import { ResultsSummary } from "./ui/ResultsSummary";
import { AnalysisSummary } from "./ui/AnalysisSummary";
import { buildAnalysisChartPoints, buildChartPoints } from "./ui/chartData";
import { loadFormInputs, saveFormInputs, substrateAnchorsFromThresholds } from "./ui/formInputs";
import "./App.css";

type AppMode = "planning" | "analysis";

function App() {
  const [mode, setMode] = useState<AppMode>("planning");
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());

  const [rawPoints, setRawPoints] = useState<GpxPoint[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const [analysisRawPoints, setAnalysisRawPoints] = useState<GpxPoint[] | null>(null);
  const [analysisFileName, setAnalysisFileName] = useState<string | null>(null);

  useEffect(() => {
    saveFormInputs(formInputs);
  }, [formInputs]);

  const pipelineOptions = useMemo(
    () => ({
      segmentLengthM: formInputs.segmentLengthM,
      smoothingWindowM: formInputs.smoothingWindowM,
    }),
    [formInputs.segmentLengthM, formInputs.smoothingWindowM],
  );

  const courseResult = useMemo(() => {
    if (!rawPoints) return null;
    return runPipeline(rawPoints, pipelineOptions);
  }, [rawPoints, pipelineOptions]);

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

  const analysisCourseResult = useMemo(() => {
    if (!analysisRawPoints) return null;
    return runPipeline(analysisRawPoints, pipelineOptions);
  }, [analysisRawPoints, pipelineOptions]);

  const analysisInputs = useMemo<AnalysisInputs | null>(() => {
    if (!analysisCourseResult || !analysisCourseResult.hasTimestamps || analysisCourseResult.segments.length === 0) {
      return null;
    }
    const { x0, k } = substrateAnchorsFromThresholds(formInputs.lt1Fraction, formInputs.lt2Fraction);
    return {
      bodyMassKg: formInputs.bodyMassKg,
      ceilingParams: { vo2MaxMlPerKgPerMin: formInputs.vo2MaxMlPerKgPerMin },
      substrateParams: { x0, k, foPeakGPerMin: formInputs.foPeakGPerMin },
      fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
      glycogenStoreG: formInputs.glycogenStoreG,
      reserveG: formInputs.reserveG,
      walkMaxMs: formInputs.walkMaxMs,
      altitudeAdjustment: formInputs.altitudeAdjustment,
    };
  }, [analysisCourseResult, formInputs]);

  const analysisResult = useMemo(() => {
    if (!analysisCourseResult || !analysisInputs) return null;
    return analyzeRun(analysisCourseResult.segments, analysisInputs);
  }, [analysisCourseResult, analysisInputs]);

  const analysisChartPoints = useMemo(() => {
    if (!analysisCourseResult || !analysisResult) return [];
    return buildAnalysisChartPoints(analysisCourseResult.segments, analysisResult.segments, formInputs.walkMaxMs);
  }, [analysisCourseResult, analysisResult, formInputs.walkMaxMs]);

  const substratePoints = useMemo(
    () =>
      analysisResult?.segments.map((s, i) => ({
        distanceKm: analysisChartPoints[i]?.distanceKm ?? 0,
        cumulativeCarbG: s.cumulativeCarbG,
        cumulativeFatG: s.cumulativeFatG,
      })) ?? [],
    [analysisResult, analysisChartPoints],
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1>Grade Runner</h1>
        <div className="mode-toggle">
          <button type="button" className={mode === "planning" ? "active" : ""} onClick={() => setMode("planning")}>
            Planning
          </button>
          <button type="button" className={mode === "analysis" ? "active" : ""} onClick={() => setMode("analysis")}>
            Analysis
          </button>
        </div>
      </header>

      {mode === "planning" ? (
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
                    {/* A handful of segments (e.g. an immediate bonk) isn't
                        enough for a meaningful chart axis/scale. */}
                    {chartPoints.length >= 5 && (
                      <>
                        <ElevationProfileChart points={chartPoints} />
                        <FuelChart points={chartPoints} reserveG={formInputs.reserveG} />
                        <SplitTable points={chartPoints} />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </main>
        </div>
      ) : (
        <div className="app__layout">
          <aside className="app__sidebar">
            <GpxUpload
              onLoaded={(points, name) => {
                setAnalysisRawPoints(points);
                setAnalysisFileName(name);
              }}
            />
            <InputsPanel values={formInputs} onChange={setFormInputs} />
          </aside>

          <main className="app__main">
            {!analysisCourseResult && (
              <p className="placeholder">Upload a recorded run's GPX (with timestamps) to get started.</p>
            )}

            {analysisCourseResult && (
              <>
                {analysisFileName && <p className="course-name">{analysisFileName}</p>}
                {!analysisCourseResult.hasTimestamps && (
                  <p className="warning">
                    This GPX has no timestamps — Analysis mode needs a recorded run, not a course. Try Planning mode
                    instead.
                  </p>
                )}
                {analysisCourseResult.hasTimestamps && !analysisCourseResult.hasElevation && (
                  <p className="warning">No elevation data found — treating the course as flat.</p>
                )}
                <p className="course-stats">
                  {(analysisCourseResult.totalDistance3D / 1000).toFixed(1)} km &middot;{" "}
                  {analysisCourseResult.totalElevationGain.toFixed(0)} m gain
                </p>

                {analysisResult && (
                  <>
                    <AnalysisSummary result={analysisResult} totalDistanceM={analysisCourseResult.totalDistance3D} />
                    {analysisChartPoints.length >= 5 && (
                      <>
                        <ElevationProfileChart points={analysisChartPoints} />
                        <FuelChart points={analysisChartPoints} reserveG={formInputs.reserveG} />
                        <SubstrateChart points={substratePoints} />
                        <SplitTable points={analysisChartPoints} />
                      </>
                    )}
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
