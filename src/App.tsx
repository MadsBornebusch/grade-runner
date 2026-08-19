import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GpxPoint } from "./gpx/pipeline";
import { rawCourseStats, runPipeline } from "./gpx/pipeline";
import { findFlatPacedFinishTime, findSustainableTheta, findThetaForTargetTime, type SolverInputs } from "./model/solver";
import { predictBestDemonstratedTheta, predictMarginTheta } from "./model/pacingMarginFit";
import { analyzeRun, type AnalysisInputs } from "./model/analysis";
import { ceilingPower } from "./model/ceiling";
import { predictEffortFractionFromHr } from "./model/hrCalibration";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "./model/surfaceExposure";
import { fetchSurfaceEdges } from "./ui/surfaceLookup";
import { GpxUpload } from "./ui/GpxUpload";
import { CourseLibraryPanel } from "./ui/CourseLibraryPanel";
import { saveCourse } from "./storage/courseLibrary";
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
import { buildAnalysisChartPoints, buildChartPoints, summarizeChartPoints, type HrEstimateInputs } from "./ui/chartData";
import { formatDuration, parseDurationToSeconds } from "./ui/format";
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
import { getRunFitStatus, subscribeToRunFit } from "./ui/runFitBatch";
import "./App.css";

type ResultMode = "planning" | "analysis";

function App() {
  const [resultMode, setResultMode] = useState<ResultMode>("planning");
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());
  const { connected: stravaConnected } = useStravaSession();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Fit runs as a module-level process (runFitBatch.ts), independent of
  // whether Settings/RunLibraryPanel is mounted -- see that file's own
  // doc. This just surfaces a badge on the gear icon when a fit finished
  // (success or error) while Settings was closed, so closing it to do
  // something else doesn't mean losing track of when the result lands.
  // Read here (App.tsx never unmounts) rather than in SettingsModal
  // itself, which does unmount when closed.
  const runFitStatus = useSyncExternalStore(subscribeToRunFit, getRunFitStatus);
  const [hasUnseenFitResult, setHasUnseenFitResult] = useState(false);
  const wasFitRunningRef = useRef(runFitStatus.running);
  useEffect(() => {
    const justFinished = wasFitRunningRef.current && !runFitStatus.running && (runFitStatus.result || runFitStatus.error);
    wasFitRunningRef.current = runFitStatus.running;
    if (justFinished && !settingsOpen) setHasUnseenFitResult(true);
  }, [runFitStatus, settingsOpen]);

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
  // Bumped after every saveCourse() to trigger CourseLibraryPanel's own
  // reload -- it doesn't own the save (App.tsx already has points/name in
  // hand right where upload/import land), so it needs an external signal.
  const [courseLibraryVersion, setCourseLibraryVersion] = useState(0);

  // Planned-finish-time mode: when set, Results shows the plan for THIS
  // target instead of the theoretical zero-margin ceiling -- an alternate
  // detail view, not a fourth number alongside ceiling/chosen/best. Kept as
  // local, unpersisted state (not formInputs) since it's tied to viewing
  // this particular course in this session, not an athlete setting.
  const [targetTimeInput, setTargetTimeInput] = useState("");

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
  // Settings is a full-screen overlay -- the Results page underneath isn't
  // visible while it's open, so there's nothing to show a fresh solve to.
  // Frozen at the last computed value (by reference) while settingsOpen is
  // true, so this and every downstream memo keyed on solverInputs
  // (solverResult, chosenPacingResult, bestDemonstratedResult,
  // targetTimeResult, chartPoints, planSummaryStats) skip the whole
  // theta-bisection cascade for every keystroke made in Settings, not just
  // the fields that don't feed it. Catches up in one solve, using
  // whatever the final formInputs ended up being, the moment Settings
  // closes (settingsOpen flipping is itself a dependency below).
  const lastSolverInputsRef = useRef<SolverInputs | null>(null);
  const solverInputs = useMemo<SolverInputs | null>(() => {
    if (settingsOpen) return lastSolverInputsRef.current;
    if (!courseResult || courseResult.segments.length === 0) {
      lastSolverInputsRef.current = null;
      return null;
    }
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
    const built: SolverInputs = {
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
      surfaceCostMultipliers: formInputs.surfaceCostMultipliers ?? undefined,
    };
    lastSolverInputsRef.current = built;
    return built;
    // Narrow, explicit field list -- the whole solver cascade downstream
    // of this (solverResult, chosenPacingResult, bestDemonstratedResult,
    // targetTimeResult, chartPoints) re-runs whenever this reference
    // changes, so depending on all of formInputs meant every keystroke in
    // ANY field -- including ones this doesn't even read, like the
    // display-only split length on the Results page -- re-ran the full
    // solver. Only list fields actually read above (directly or via
    // resolveLt1Lt2Fractions/resolveSubstrateAnchors/resolveCeilingParams/
    // resolveGlycogenStoreG).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settingsOpen,
    courseResult,
    formInputs.bodyMassKg,
    formInputs.vo2MaxHistory,
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.walkMaxMs,
    formInputs.fatOxPoints,
    formInputs.f0,
    formInputs.fInf,
    formInputs.tauMin,
    formInputs.pacingCurveEnabled,
    formInputs.durabilityDriftPerHour,
    formInputs.foPeakGPerMin,
    formInputs.intakeGPerH,
    formInputs.glycogenGPerKg,
    formInputs.forceWalkAboveGrade,
    formInputs.altitudeAdjustment,
    formInputs.unpavedCostMultiplier,
    formInputs.surfaceCostMultipliers,
  ]);

  const solverResult = useMemo(() => {
    if (!solverInputs) return null;
    return findSustainableTheta(solverInputs);
  }, [solverInputs]);

  // "Chosen pacing" and "best demonstrated" -- the two grounded numbers
  // shown alongside solverResult's own zero-margin theoretical ceiling (see
  // ResultsSummary). Both reuse findFlatPacedFinishTime's self-consistent
  // duration solve, just with the target fraction scaled by the athlete's
  // OWN fitted pacing-margin curve (pacingMarginFit.ts) instead of 100% of
  // the fitted ceiling -- undefined pacingMargin (not yet fit; needs
  // MIN_MARGIN_FIT_RACES confirmed races) means neither renders.
  const chosenPacingResult = useMemo(() => {
    if (!solverInputs || !formInputs.pacingMargin) return null;
    const margin = formInputs.pacingMargin;
    return findFlatPacedFinishTime(solverInputs, { marginCurve: (h) => predictMarginTheta(h, margin) });
  }, [solverInputs, formInputs.pacingMargin]);

  const bestDemonstratedResult = useMemo(() => {
    if (!solverInputs || !formInputs.pacingMargin) return null;
    const margin = formInputs.pacingMargin;
    return findFlatPacedFinishTime(solverInputs, { marginCurve: (h) => predictBestDemonstratedTheta(h, margin) });
  }, [solverInputs, formInputs.pacingMargin]);

  // Same shape predictFinishTimeRange needs (everything findSustainableTheta
  // needs except segments/ceilingParams, both of which vary per bootstrap
  // candidate/target).
  const solverBaseInputs = useMemo(() => {
    if (!solverInputs) return null;
    const { segments: _segments, ceilingParams: _ceilingParams, ...rest } = solverInputs;
    return rest;
  }, [solverInputs]);

  // Shared by both chart-point builders below -- undefined (not applied)
  // whenever no HR-effort calibration has been fit yet, so estimated HR
  // simply doesn't appear rather than showing a meaningless number.
  // Same freeze as solverInputs/analysisInputs above -- feeds chartPoints's
  // own dependency array, so an unnecessary new reference here would still
  // re-run buildChartPoints on every keystroke in Settings even with
  // solverInputs itself frozen.
  const lastHrEstimateInputsRef = useRef<HrEstimateInputs | undefined>(undefined);
  const hrEstimateInputs = useMemo<HrEstimateInputs | undefined>(() => {
    if (settingsOpen) return lastHrEstimateInputsRef.current;
    if (formInputs.hrEffortCalibrationSlope === null || formInputs.hrEffortCalibrationIntercept === null) {
      lastHrEstimateInputsRef.current = undefined;
      return undefined;
    }
    const built: HrEstimateInputs = {
      ceilingParams: resolveCeilingParams(formInputs),
      altitudeAdjustment: formInputs.altitudeAdjustment,
      calibration: {
        slope: formInputs.hrEffortCalibrationSlope,
        intercept: formInputs.hrEffortCalibrationIntercept,
        rSquared: 0,
        pointCount: 0,
        raceCount: 0,
      },
    };
    lastHrEstimateInputsRef.current = built;
    return built;
    // Narrow field list -- see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settingsOpen,
    formInputs.hrEffortCalibrationSlope,
    formInputs.hrEffortCalibrationIntercept,
    formInputs.vo2MaxHistory,
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.walkMaxMs,
    formInputs.f0,
    formInputs.fInf,
    formInputs.tauMin,
    formInputs.pacingCurveEnabled,
    formInputs.durabilityDriftPerHour,
    formInputs.altitudeAdjustment,
  ]);

  const targetTimeS = useMemo(() => parseDurationToSeconds(targetTimeInput), [targetTimeInput]);

  const targetTimeResult = useMemo(() => {
    if (!solverInputs || targetTimeS === null) return null;
    return findThetaForTargetTime(solverInputs, targetTimeS);
  }, [solverInputs, targetTimeS]);

  // Planning mode's detail view (charts/splits/averages) follows whichever
  // plan is active: the user's target time when set, else their own fitted
  // pacing-margin curve, else the theoretical ceiling as a last resort --
  // the SAME priority ResultsSummary uses to pick its headline stat. This
  // used to fall straight from target to the zero-margin ceiling, skipping
  // chosen pacing entirely -- so whenever "Chosen pacing" was the promoted
  // headline number, the avg pace/GAP/HR row and elevation-pace chart right
  // below it were silently describing a DIFFERENT plan (the theoretical
  // ceiling, never actually achieved) instead of the number the athlete was
  // actually looking at.
  const activeResult = targetTimeResult ?? chosenPacingResult ?? solverResult;

  const chartPoints = useMemo(() => {
    if (!courseResult || !activeResult) return [];
    return buildChartPoints(courseResult.segments, activeResult.result.segments, hrEstimateInputs);
  }, [courseResult, activeResult, hrEstimateInputs]);

  const planSummaryStats = useMemo(() => summarizeChartPoints(chartPoints), [chartPoints]);

  // Same "Settings is a full-screen overlay, nothing to show a fresh
  // rebuild to" freeze as solverInputs above.
  const lastAnalysisInputsRef = useRef<AnalysisInputs | null>(null);
  const analysisInputs = useMemo<AnalysisInputs | null>(() => {
    if (settingsOpen) return lastAnalysisInputsRef.current;
    if (
      resultMode !== "analysis" ||
      !courseResult ||
      !courseResult.hasTimestamps ||
      courseResult.segments.length === 0
    ) {
      lastAnalysisInputsRef.current = null;
      return null;
    }
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
    const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
    const built: AnalysisInputs = {
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
      surfaceCostMultipliers: formInputs.surfaceCostMultipliers ?? undefined,
    };
    lastAnalysisInputsRef.current = built;
    return built;
    // Narrow field list -- same reasoning as solverInputs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settingsOpen,
    resultMode,
    courseResult,
    formInputs.bodyMassKg,
    formInputs.vo2MaxHistory,
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.walkMaxMs,
    formInputs.fatOxPoints,
    formInputs.f0,
    formInputs.fInf,
    formInputs.tauMin,
    formInputs.pacingCurveEnabled,
    formInputs.durabilityDriftPerHour,
    formInputs.foPeakGPerMin,
    formInputs.intakeGPerH,
    formInputs.glycogenGPerKg,
    formInputs.altitudeAdjustment,
    formInputs.unpavedCostMultiplier,
    formInputs.surfaceCostMultipliers,
  ]);

  const analysisResult = useMemo(() => {
    if (!courseResult || !analysisInputs) return null;
    return analyzeRun(courseResult.segments, analysisInputs);
  }, [courseResult, analysisInputs]);

  const analysisChartPoints = useMemo(() => {
    if (!courseResult || !analysisResult) return [];
    return buildAnalysisChartPoints(courseResult.segments, analysisResult.segments, formInputs.walkMaxMs, hrEstimateInputs);
  }, [courseResult, analysisResult, formInputs.walkMaxMs, hrEstimateInputs]);

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
          onClick={() => {
            setSettingsOpen(true);
            setHasUnseenFitResult(false);
          }}
          aria-label={hasUnseenFitResult ? "Open settings -- your fit result is ready" : "Open settings"}
        >
          ⚙
          {hasUnseenFitResult && <span className="app__settings-badge" aria-hidden="true" />}
        </button>
      </header>

      <PageCarousel
        pages={[
          {
            label: "Course",
            content: (
              <>
                <CourseLibraryPanel
                  refreshKey={courseLibraryVersion}
                  onSelect={(points, name) => {
                    setRawPoints(points);
                    setFileName(name);
                  }}
                />
                <GpxUpload
                  onLoaded={(points, name) => {
                    setRawPoints(points);
                    setFileName(name);
                    void saveCourse(name, points).then(() => setCourseLibraryVersion((v) => v + 1));
                  }}
                />
                <StravaImport
                  onImport={(points, name, stravaId) => {
                    setRawPoints(points);
                    setFileName(name);
                    void saveCourse(name, points, stravaId !== undefined ? `strava:${stravaId}` : undefined).then(() =>
                      setCourseLibraryVersion((v) => v + 1),
                    );
                  }}
                />
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
                    <CourseProcessingFields values={formInputs} onChange={setFormInputs} />
                    <FuelingFields values={formInputs} onChange={setFormInputs} />
                    {formInputs.showCourseDebug && rawStats && (
                      <CourseDebugChart
                        raw={rawStats}
                        processed={debugProcessedPoints}
                        processedDistanceM={courseResult.totalDistance3D}
                        processedElevationGain={courseResult.totalElevationGain}
                        segmentLengthM={formInputs.segmentLengthM}
                        smoothingWindowM={formInputs.smoothingWindowM}
                      />
                    )}
                  </>
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
                        <div className="target-time-input">
                          <label>
                            Target finish time
                            <input
                              type="text"
                              placeholder="H:MM"
                              value={targetTimeInput}
                              onChange={(e) => setTargetTimeInput(e.target.value)}
                            />
                          </label>
                          {targetTimeInput && (
                            <button type="button" onClick={() => setTargetTimeInput("")}>
                              Clear
                            </button>
                          )}
                          {targetTimeInput && targetTimeS === null && (
                            <p className="warning">Enter a time as H:MM or H:MM:SS.</p>
                          )}
                        </div>
                        <ResultsSummary
                          theta={solverResult.theta}
                          result={solverResult.result}
                          totalDistanceM={courseResult.totalDistance3D}
                          chosenPacing={chosenPacingResult}
                          bestDemonstrated={bestDemonstratedResult}
                          summaryStats={planSummaryStats}
                          target={
                            targetTimeResult && targetTimeS !== null
                              ? { result: targetTimeResult.result, theta: targetTimeResult.theta, targetTimeS }
                              : null
                          }
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
                            {targetTimeResult && targetTimeS !== null && (
                              <p className="field-group-note">
                                Splits and charts below show your {formatDuration(targetTimeS)} target
                                {Math.abs(targetTimeResult.result.finishTimeS - targetTimeS) > 60
                                  ? " (closest achievable pace, not exact)"
                                  : ""}
                                . Clear it to go back to the theoretical ceiling.
                              </p>
                            )}
                            <ElevationProfileChart points={chartPoints} />
                            <FuelChart points={chartPoints} />
                            <SplitTable
                              points={chartPoints}
                              splitLengthKm={formInputs.splitLengthKm}
                              onSplitLengthChange={(splitLengthKm) => setFormInputs((prev) => ({ ...prev, splitLengthKm }))}
                            />
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
                                onApplyTau={(tauMin) => setFormInputs((prev) => ({ ...prev, tauMin }))}
                                onApplyDrift={(durabilityDriftPerHour) =>
                                  setFormInputs((prev) => ({ ...prev, durabilityDriftPerHour }))
                                }
                              />
                            )}
                            <FuelChart points={analysisChartPoints} />
                            <SubstrateChart points={substratePoints} />
                            <SplitTable
                              points={analysisChartPoints}
                              splitLengthKm={formInputs.splitLengthKm}
                              onSplitLengthChange={(splitLengthKm) => setFormInputs((prev) => ({ ...prev, splitLengthKm }))}
                            />
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
        onApplyTau={(tauMin) => setFormInputs((prev) => ({ ...prev, tauMin }))}
        onApplyFInf={(fInf) => setFormInputs((prev) => ({ ...prev, fInf }))}
        onApplySurfaceCostMultipliers={(surfaceCostMultipliers) => setFormInputs((prev) => ({ ...prev, surfaceCostMultipliers }))}
        onApplyHrCalibration={(hrEffortCalibrationSlope, hrEffortCalibrationIntercept) =>
          setFormInputs((prev) => ({ ...prev, hrEffortCalibrationSlope, hrEffortCalibrationIntercept }))
        }
        onApplyPacingMargin={(fit) =>
          setFormInputs((prev) => ({
            ...prev,
            pacingMargin: { marginFInf: fit.marginFInf, marginTauHours: fit.marginTauHours, bestUpsideOffset: fit.bestUpsideOffset },
          }))
        }
        onAddVo2MaxEntry={(entry: Vo2MaxEntry) =>
          setFormInputs((prev) => ({ ...prev, vo2MaxHistory: [...prev.vo2MaxHistory, entry] }))
        }
        onRacesFitted={(races, raceDates) => setFittedRaces({ races, raceDates })}
      />
    </div>
  );
}

export default App;
