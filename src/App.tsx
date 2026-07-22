import { useEffect, useMemo, useState } from "react";
import type { GpxPoint } from "./gpx/pipeline";
import { rawCourseStats, runPipeline } from "./gpx/pipeline";
import { findSustainableTheta, type SolverInputs } from "./model/solver";
import { analyzeRun, type AnalysisInputs } from "./model/analysis";
import { ceilingPower } from "./model/ceiling";
import { predictEffortFractionFromHr } from "./model/hrCalibration";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "./model/surfaceExposure";
import { fetchSurfaceEdges } from "./ui/surfaceLookup";
import { GpxUpload } from "./ui/GpxUpload";
import { CourseProcessingFields, FuelingFields } from "./ui/InputsPanel";
import { PageCarousel } from "./ui/PageCarousel";
import { ElevationProfileChart } from "./ui/ElevationProfileChart";
import { FinishTimeRangePanel } from "./ui/FinishTimeRangePanel";
import { CourseDebugChart } from "./ui/CourseDebugChart";
import { FuelChart } from "./ui/FuelChart";
import { SubstrateChart } from "./ui/SubstrateChart";
import { PaceEffortChart } from "./ui/PaceEffortChart";
import { PacingFitPanel } from "./ui/PacingFitPanel";
import { PowerHrChart } from "./ui/PowerHrChart";
import { SettingsModal } from "./ui/SettingsModal";
import { StravaImport } from "./ui/StravaImport";
import { buildEffortTrendPoints, type EffortTrendPoint } from "./model/pacingFit";
import { SplitTable } from "./ui/SplitTable";
import { ResultsSummary } from "./ui/ResultsSummary";
import { AnalysisSummary } from "./ui/AnalysisSummary";
import { buildAnalysisChartPoints, buildChartPoints } from "./ui/chartData";
import {
  loadFormInputs,
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  saveFormInputs,
  type FormInputs,
  type Vo2MaxEntry,
} from "./ui/formInputs";
import { useStravaSession } from "./ui/useStravaSession";
import "./App.css";

type ResultMode = "planning" | "analysis";

function App() {
  const [resultMode, setResultMode] = useState<ResultMode>("planning");
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());
  const { connected: stravaConnected } = useStravaSession();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The races/raceDates behind the Settings modal's most recent tau/fInf
  // fit -- lifted up here (rather than kept local to RunLibraryPanel) so
  // the Results tab's finish-time-range feature can reuse the exact same
  // training data without RunLibraryPanel needing to know about Planning
  // mode's course or the solver.
  const [fittedRaces, setFittedRaces] = useState<{ races: EffortTrendPoint[][]; raceDates: (Date | null)[] } | null>(
    null,
  );

  const [rawPoints, setRawPoints] = useState<GpxPoint[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  useEffect(() => {
    saveFormInputs(formInputs);
  }, [formInputs]);

  // Cross-device settings sync, gated on being Strava-connected: pull any
  // previously-saved settings once on connect (overriding this browser's
  // localStorage), then push local changes back up, debounced so typing in
  // a number field doesn't fire a request per keystroke.
  useEffect(() => {
    if (!stravaConnected) return;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { settings: Partial<FormInputs> | null } | null) => {
        if (body?.settings) setFormInputs((prev) => ({ ...prev, ...body.settings }));
      })
      .catch(() => {});
  }, [stravaConnected]);

  useEffect(() => {
    if (!stravaConnected) return;
    const timeout = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formInputs),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timeout);
  }, [stravaConnected, formInputs]);

  const pipelineOptions = useMemo(
    () => ({
      segmentLengthM: formInputs.segmentLengthM,
      smoothingWindowM: formInputs.smoothingWindowM,
    }),
    [formInputs.segmentLengthM, formInputs.smoothingWindowM],
  );

  // Fetched once per upload (not per pipelineOptions change -- segment
  // length/smoothing don't change the underlying GPS points a surface
  // lookup needs), applied to courseResult's segments below. A failed/slow
  // lookup just means predictions proceed without a surface term, exactly
  // like unpavedCostMultiplier's own "no effect on segments with no
  // surface data" contract -- never blocks or errors the rest of planning.
  const [surfaceEdges, setSurfaceEdges] = useState<ValhallaSurfaceEdge[] | null>(null);
  useEffect(() => {
    setSurfaceEdges(null);
    if (!rawPoints) return;
    let cancelled = false;
    fetchSurfaceEdges(rawPoints).then((edges) => {
      if (!cancelled) setSurfaceEdges(edges);
    });
    return () => {
      cancelled = true;
    };
  }, [rawPoints]);

  // One upload, one pipeline run -- both Planning and Analysis results derive
  // from this, so switching between them doesn't need a fresh upload.
  const courseResult = useMemo(() => {
    if (!rawPoints) return null;
    const result = runPipeline(rawPoints, pipelineOptions);
    if (!surfaceEdges) return result;
    return { ...result, segments: attachSurfaceData(result.segments, surfaceEdges) };
  }, [rawPoints, pipelineOptions, surfaceEdges]);

  const rawStats = useMemo(() => (rawPoints ? rawCourseStats(rawPoints) : null), [rawPoints]);

  const debugProcessedPoints = useMemo(
    () =>
      courseResult?.segments.map((s) => ({
        distanceKm: s.cumulativeDistance3D / 1000,
        elevationM: s.elevation,
      })) ?? [],
    [courseResult],
  );

  // The solved plan is computed regardless of resultMode: Planning shows it
  // directly, and Analysis overlays it against the recorded run (see
  // PaceEffortChart), so both need it available at once. Since useMemo is
  // synchronous, switching resultMode itself is still instant -- no
  // re-upload, no spinner.
  const solverInputs = useMemo<SolverInputs | null>(() => {
    if (!courseResult || courseResult.segments.length === 0) return null;
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
    return {
      segments: courseResult.segments,
      bodyMassKg: formInputs.bodyMassKg,
      ceilingParams: resolveCeilingParams(formInputs),
      substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: formInputs.foPeakGPerMin },
      fueling: { intakeGPerH: formInputs.intakeGPerH },
      glycogenStoreG: resolveGlycogenStoreG(formInputs),
      walkMaxMs: formInputs.walkMaxMs,
      forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
      altitudeAdjustment: formInputs.altitudeAdjustment,
      unpavedCostMultiplier: formInputs.unpavedCostMultiplier,
    };
  }, [courseResult, formInputs]);

  const solverResult = useMemo(() => {
    if (!solverInputs) return null;
    return findSustainableTheta(solverInputs);
  }, [solverInputs]);

  // Same shape predictFinishTimeRange needs (everything findSustainableTheta
  // needs except segments/ceilingParams, both of which vary per bootstrap
  // candidate/target).
  const solverBaseInputs = useMemo(() => {
    if (!solverInputs) return null;
    const { segments: _segments, ceilingParams: _ceilingParams, ...rest } = solverInputs;
    return rest;
  }, [solverInputs]);

  const chartPoints = useMemo(() => {
    if (!courseResult || !solverResult) return [];
    return buildChartPoints(courseResult.segments, solverResult.result.segments);
  }, [courseResult, solverResult]);

  const analysisInputs = useMemo<AnalysisInputs | null>(() => {
    if (
      resultMode !== "analysis" ||
      !courseResult ||
      !courseResult.hasTimestamps ||
      courseResult.segments.length === 0
    ) {
      return null;
    }
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
    return {
      bodyMassKg: formInputs.bodyMassKg,
      // Full ceilingParams, matching solverInputs below -- analyzeRun's
      // effortFraction calls ceilingPower (not just maxAerobicPower), so it
      // needs the pacing-fade/LT2/drift params too, not just VO2max. Passing
      // only vo2MaxMlPerKgPerMin here silently fell back to ceiling.ts's
      // defaults for everyone who'd customized their pacing curve.
      ceilingParams: resolveCeilingParams(formInputs),
      substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: formInputs.foPeakGPerMin },
      fueling: { intakeGPerH: formInputs.intakeGPerH },
      glycogenStoreG: resolveGlycogenStoreG(formInputs),
      walkMaxMs: formInputs.walkMaxMs,
      altitudeAdjustment: formInputs.altitudeAdjustment,
      // Genuine retrospective display (this is Analysis mode reconstructing
      // a real past run, not RunLibraryPanel building training data for the
      // fit itself) -- the real fitted value belongs here, unlike
      // RunLibraryPanel's own analyzeRun call which deliberately omits it.
      unpavedCostMultiplier: formInputs.unpavedCostMultiplier,
    };
  }, [resultMode, courseResult, formInputs]);

  const analysisResult = useMemo(() => {
    if (!courseResult || !analysisInputs) return null;
    return analyzeRun(courseResult.segments, analysisInputs);
  }, [courseResult, analysisInputs]);

  const analysisChartPoints = useMemo(() => {
    if (!courseResult || !analysisResult) return [];
    return buildAnalysisChartPoints(courseResult.segments, analysisResult.segments, formInputs.walkMaxMs);
  }, [courseResult, analysisResult, formInputs.walkMaxMs]);

  const substratePoints = useMemo(
    () =>
      analysisResult?.segments.map((s, i) => ({
        distanceKm: analysisChartPoints[i]?.distanceKm ?? 0,
        cumulativeCarbG: s.cumulativeCarbG,
        cumulativeFatG: s.cumulativeFatG,
      })) ?? [],
    [analysisResult, analysisChartPoints],
  );

  const paceEffortActualPoints = useMemo(
    () =>
      analysisResult?.segments.map((s, i) => ({
        distanceKm: analysisChartPoints[i]?.distanceKm ?? 0,
        paceMinPerKm: s.speedMs > 0 ? 1000 / s.speedMs / 60 : null,
        effortPct: s.effortFraction !== null ? s.effortFraction * 100 : null,
      })) ?? [],
    [analysisResult, analysisChartPoints],
  );

  const paceEffortPlannedPoints = useMemo(
    () =>
      chartPoints.map((p) => ({
        distanceKm: p.distanceKm,
        paceMinPerKm: p.speedMs > 0 ? 1000 / p.speedMs / 60 : null,
      })),
    [chartPoints],
  );

  const powerHrPoints = useMemo(
    () =>
      analysisResult?.segments.map((s, i) => {
        const seg = courseResult?.segments[s.index];
        const heartRateBpm = seg?.heartRateBpm ?? null;
        let calibratedPowerW: number | null = null;
        if (
          heartRateBpm !== null &&
          formInputs.hrEffortCalibrationSlope !== null &&
          formInputs.hrEffortCalibrationIntercept !== null &&
          analysisInputs?.ceilingParams
        ) {
          const tHours = (s.cumulativeElapsedTimeS - s.timeS) / 3600;
          const altitudeM = formInputs.altitudeAdjustment ? (seg?.elevation ?? 0) : 0;
          const ceiling = ceilingPower({ tMin: tHours * 60, altitudeM, elapsedHours: tHours }, analysisInputs.ceilingParams);
          const effortFraction = predictEffortFractionFromHr(heartRateBpm, {
            slope: formInputs.hrEffortCalibrationSlope,
            intercept: formInputs.hrEffortCalibrationIntercept,
            rSquared: 0,
            pointCount: 0,
            raceCount: 0,
          });
          if (ceiling > 0) calibratedPowerW = effortFraction * ceiling * formInputs.bodyMassKg;
        }
        return {
          distanceKm: analysisChartPoints[i]?.distanceKm ?? 0,
          measuredPowerW: seg?.powerWatts ?? null,
          modeledPowerW: s.grossPowerWPerKg * formInputs.bodyMassKg,
          heartRateBpm,
          calibratedPowerW,
        };
      }) ?? [],
    [analysisResult, courseResult, analysisInputs, analysisChartPoints, formInputs],
  );

  const pacingFitPoints = useMemo(() => {
    if (!analysisResult || !courseResult) return [];
    return buildEffortTrendPoints(courseResult.segments, analysisResult.segments, formInputs.altitudeAdjustment);
  }, [analysisResult, courseResult, formInputs.altitudeAdjustment]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Grade Runner</h1>
        <button
          type="button"
          className="app__settings-button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
        >
          ⚙
        </button>
      </header>

      <PageCarousel
        pages={[
          {
            label: "Course",
            content: (
              <>
                <GpxUpload
                  onLoaded={(points, name) => {
                    setRawPoints(points);
                    setFileName(name);
                  }}
                />
                <StravaImport
                  onImport={(points, name) => {
                    setRawPoints(points);
                    setFileName(name);
                  }}
                />
                {fileName && <p className="course-name">{fileName}</p>}
                {courseResult && !courseResult.hasElevation && (
                  <p className="warning">No elevation data found — treating the course as flat.</p>
                )}
                {courseResult && (
                  <p className="course-stats">
                    {(courseResult.totalDistance3D / 1000).toFixed(1)} km &middot;{" "}
                    {courseResult.totalElevationGain.toFixed(0)} m gain
                  </p>
                )}
                <CourseProcessingFields values={formInputs} onChange={setFormInputs} />
                <FuelingFields values={formInputs} onChange={setFormInputs} />
                {formInputs.showCourseDebug && rawStats && (
                  <CourseDebugChart
                    raw={rawStats}
                    processed={debugProcessedPoints}
                    processedDistanceM={courseResult?.totalDistance3D ?? 0}
                    processedElevationGain={courseResult?.totalElevationGain ?? 0}
                    segmentLengthM={formInputs.segmentLengthM}
                    smoothingWindowM={formInputs.smoothingWindowM}
                  />
                )}
              </>
            ),
          },
          {
            label: "Results",
            content: (
              <>
                <div className="mode-toggle">
                  <button
                    type="button"
                    className={resultMode === "planning" ? "active" : ""}
                    onClick={() => setResultMode("planning")}
                  >
                    Planning
                  </button>
                  <button
                    type="button"
                    className={resultMode === "analysis" ? "active" : ""}
                    onClick={() => setResultMode("analysis")}
                    disabled={courseResult !== null && !courseResult.hasTimestamps}
                  >
                    Analysis
                  </button>
                </div>

                {!courseResult && <p className="placeholder">Upload a course GPX on the Course page to get started.</p>}

                {courseResult && (
                  <>
                    {resultMode === "planning" && solverResult && (
                      <>
                        <ResultsSummary
                          theta={solverResult.theta}
                          result={solverResult.result}
                          totalDistanceM={courseResult.totalDistance3D}
                        />
                        {solverInputs && solverBaseInputs && (
                          <FinishTimeRangePanel
                            fittedRaces={fittedRaces}
                            ceilingParams={solverInputs.ceilingParams ?? {}}
                            solverBaseInputs={solverBaseInputs}
                            targetSegments={courseResult.segments}
                          />
                        )}
                        {/* A handful of segments (e.g. an immediate bonk) isn't
                            enough for a meaningful chart axis/scale. */}
                        {chartPoints.length >= 5 && (
                          <>
                            <ElevationProfileChart points={chartPoints} />
                            <FuelChart points={chartPoints} />
                            <SplitTable points={chartPoints} />
                          </>
                        )}
                      </>
                    )}

                    {resultMode === "analysis" && !courseResult.hasTimestamps && (
                      <p className="warning">
                        This GPX has no timestamps — Analysis mode needs a recorded run, not a course. Switch to
                        Planning, or upload a run with a recorded time.
                      </p>
                    )}
                    {resultMode === "analysis" && analysisResult && (
                      <>
                        <AnalysisSummary result={analysisResult} totalDistanceM={courseResult.totalDistance3D} />
                        {analysisChartPoints.length >= 5 && (
                          <>
                            <ElevationProfileChart points={analysisChartPoints} />
                            {solverResult && (
                              <PaceEffortChart
                                actual={paceEffortActualPoints}
                                planned={paceEffortPlannedPoints}
                                plannedThetaFraction={solverResult.theta}
                              />
                            )}
                            {(courseResult.hasPower || courseResult.hasHeartRate) && (
                              <PowerHrChart
                                points={powerHrPoints}
                                hasPower={courseResult.hasPower}
                                hasHeartRate={courseResult.hasHeartRate}
                                hasCalibratedPower={
                                  courseResult.hasHeartRate &&
                                  formInputs.hrEffortCalibrationSlope !== null &&
                                  formInputs.hrEffortCalibrationIntercept !== null
                                }
                              />
                            )}
                            {analysisInputs && (
                              <PacingFitPanel
                                points={pacingFitPoints}
                                ceilingParams={analysisInputs.ceilingParams ?? {}}
                                onApplyTau={(tauMin) => setFormInputs({ ...formInputs, tauMin })}
                                onApplyDrift={(durabilityDriftPerHour) =>
                                  setFormInputs({ ...formInputs, durabilityDriftPerHour })
                                }
                              />
                            )}
                            <FuelChart points={analysisChartPoints} />
                            <SubstrateChart points={substratePoints} />
                            <SplitTable points={analysisChartPoints} />
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            ),
          },
        ]}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        formInputs={formInputs}
        onChange={setFormInputs}
        onApplyTau={(tauMin) => setFormInputs({ ...formInputs, tauMin })}
        onApplyFInf={(fInf) => setFormInputs({ ...formInputs, fInf })}
        onApplyUnpavedCostMultiplier={(unpavedCostMultiplier) => setFormInputs({ ...formInputs, unpavedCostMultiplier })}
        onApplyHrCalibration={(hrEffortCalibrationSlope, hrEffortCalibrationIntercept) =>
          setFormInputs({ ...formInputs, hrEffortCalibrationSlope, hrEffortCalibrationIntercept })
        }
        onAddVo2MaxEntry={(entry: Vo2MaxEntry) =>
          setFormInputs({ ...formInputs, vo2MaxHistory: [...formInputs.vo2MaxHistory, entry] })
        }
        onRacesFitted={(races, raceDates) => setFittedRaces({ races, raceDates })}
      />
    </div>
  );
}

export default App;
