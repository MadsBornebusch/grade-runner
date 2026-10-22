import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { MapTrifold, Warning } from "@phosphor-icons/react";
import type { GpxPoint } from "../../gpx/pipeline";
import { rawCourseStats, runPipeline } from "../../gpx/pipeline";
import { findFlatPacedFinishTime, findThetaForTargetTime, type SolverInputs } from "../../model/solver";
import { predictBestDemonstratedTheta, predictMarginTheta } from "../../model/pacingMarginFit";
import { analyzeRun, type AnalysisInputs } from "../../model/analysis";
import { predictPowerFromHr } from "../../model/hrCalibration";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../../model/surfaceExposure";
import { fetchSurfaceEdges } from "../surfaceLookup";
import { AddCoursePanel } from "../AddCoursePanel";
import { CourseLibraryPanel } from "../CourseLibraryPanel";
import { listStoredCourses, saveCourse, updateStoredCourseCheckpoints } from "../../storage/courseLibrary";
import { planSettingsStore } from "../../storage/planSettings";
import { FuelingFields } from "../InputsPanel";
import { ElevationProfileChart } from "../ElevationProfileChart";
import { GradeHistogram } from "../GradeHistogram";
import { FuelChart } from "../FuelChart";
import { SubstrateChart } from "../SubstrateChart";
import { PaceEffortChart } from "../PaceEffortChart";
import { RouteMap } from "../RouteMap";
import { PacingFitPanel } from "../PacingFitPanel";
import { PowerHrChart } from "../PowerHrChart";
import { buildEffortTrendPoints } from "../../model/pacingFit";
import { SplitTable } from "../SplitTable";
import { ResultsSummary } from "../ResultsSummary";
import { AnalysisSummary } from "../AnalysisSummary";
import {
  buildAnalysisChartPoints,
  buildChartPoints,
  buildGradeHistogram,
  summarizeChartPoints,
  type HrEstimateInputs,
} from "../chartData";
import { formatDuration, parseDurationToSeconds } from "../format";
import {
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FormInputs,
} from "../formInputs";
import { RACE_SEGMENTS, type RaceSegment } from "./raceSegments";
import { buildSolverInputs } from "../solverInputs";
import { GoalRaceCard } from "../plan/GoalRaceCard";
import type { PlanState } from "../usePlan";


interface RaceTabProps {
  formInputs: FormInputs;
  setFormInputs: Dispatch<SetStateAction<FormInputs>>;
  /** False while another tab is showing: the solver cascade below freezes
   * at its last value, as it used to while the Settings overlay was open. */
  active: boolean;
  segment: RaceSegment;
  onSegmentChange: (segment: RaceSegment) => void;
  plan: PlanState;
}

/** The race planner: course library, pacing plan and run analysis, the
 * three pages that used to be the app's carousel. */
export function RaceTab({ formInputs, setFormInputs, active, segment, onSegmentChange, plan }: RaceTabProps) {
  const resultMode = segment === "analyze" ? "analysis" : "planning";
  const frozen = !active;
  const [addCourseOpen, setAddCourseOpen] = useState(false);

  const [rawPoints, setRawPoints] = useState<GpxPoint[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Bumped after every saveCourse() to trigger CourseLibraryPanel's own
  // reload -- it doesn't own the save (App.tsx already has points/name in
  // hand right where upload/import land), so it needs an external signal.
  const [courseLibraryVersion, setCourseLibraryVersion] = useState(0);
  // The course library row this session is currently viewing/editing, if
  // any -- lets the savedPointsKm/targetTimeS persistence effects below
  // know which row to write back to. Null until AddCoursePanel's
  // onCourseLoaded (below) resolves saveCourse(), or a course is
  // re-selected from CourseLibraryPanel (which already knows its own id).
  const [currentCourseId, setCurrentCourseId] = useState<string | null>(null);

  // Planned-finish-time mode: when set, Results shows the plan for THIS
  // target instead of the theoretical zero-margin ceiling -- an alternate
  // detail view, not a fourth number alongside ceiling/chosen/best.
  // Persisted per-course (see the targetTimeS effect below), not in
  // formInputs -- it's tied to this specific course, not an athlete-wide
  // setting.
  const [targetTimeInput, setTargetTimeInput] = useState("");

  // Shared between RouteMap and whichever charts are on screen (Planning or
  // Analysis) -- clicking a point on the route map highlights the same
  // distance in the charts below, regardless of which mode is active. NOT
  // persisted (unlike savedPointsKm/targetTimeInput below) -- it's a
  // transient "what am I looking at right now" selection, not a plan.
  const [highlightedDistanceKm, setHighlightedDistanceKm] = useState<number | null>(null);

  // Points saved from RouteMap for aid-station planning -- feeds
  // SplitTable's own custom-boundary mode. Persisted per-course (see the
  // effect below) so refreshing the page or re-selecting this course later
  // brings them back instead of starting from an empty map every time.
  const [savedPointsKm, setSavedPointsKm] = useState<number[]>([]);
  const saveHighlightedPoint = (km: number) => setSavedPointsKm((prev) => (prev.includes(km) ? prev : [...prev, km]));
  const removeSavedPoint = (km: number) => setSavedPointsKm((prev) => prev.filter((k) => k !== km));
  const clearSavedPoints = () => setSavedPointsKm([]);

  // Writes savedPointsKm back to whichever course row is active, whenever
  // it changes -- skipped entirely with no course loaded yet (courseId
  // null) or immediately after loadCourse's OWN restore below sets it to
  // the value it was just read from (a harmless redundant write, not
  // skipped specially -- distinguishing "just restored" from "user just
  // changed it" isn't worth the complexity for an idempotent write).
  useEffect(() => {
    if (!currentCourseId) return;
    void updateStoredCourseCheckpoints(currentCourseId, { savedPointsKm });
  }, [currentCourseId, savedPointsKm]);

  /** Single entry point for "a course is now the one being viewed" --
   * CourseLibraryPanel's onSelect and AddCoursePanel's onCourseLoaded (once
   * its saveCourse() resolves) both funnel through this, so the reset/
   * restore of highlightedDistanceKm/savedPointsKm/targetTimeInput can't
   * drift out of sync between the two entry points the way two separate
   * useEffects keyed on `rawPoints` alone could (that approach raced: an
   * effect resetting savedPointsKm to [] on every rawPoints change would
   * stomp a restore this function does inline, since effects run AFTER
   * the render the restore already committed in). */
  function loadCourse(points: GpxPoint[], name: string, id: string, savedKm: number[] | undefined, targetS: number | null | undefined) {
    setRawPoints(points);
    setFileName(name);
    setCurrentCourseId(id);
    setHighlightedDistanceKm(null);
    setSavedPointsKm(savedKm ?? []);
    // The goal course's target is the goal race's own expected time.
    const goal = planSettingsStore.get().goalRace;
    const target = goal?.courseId === id ? (goal.expectedHoursOverride ? goal.expectedHoursOverride * 3600 : null) : targetS;
    setTargetTimeInput(target != null ? formatDuration(target) : "");
  }

  // One target time per race (user request, 2026-10-22): on the goal
  // course, the Pacing target and the Goal race card's "your time" are the
  // same setting, so changing either changes both (and sizes the plan).
  const goalRace = planSettingsStore.use().goalRace;
  const isGoalCourse = !!goalRace && goalRace.courseId === currentCourseId;
  // Pacing opened with nothing loaded (a fresh app open): show the goal
  // race's course rather than an empty page.
  useEffect(() => {
    if (segment !== "pacing" || currentCourseId || rawPoints || !goalRace) return;
    let cancelled = false;
    void listStoredCourses().then((courses) => {
      const c = courses.find((x) => x.id === goalRace.courseId);
      if (c && !cancelled) loadCourse(c.points, c.name, c.id, c.savedPointsKm, c.targetTimeS);
    });
    return () => {
      cancelled = true;
    };
    // loadCourse only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, currentCourseId, rawPoints, goalRace?.courseId]);
  const goalTargetS = isGoalCourse && goalRace.expectedHoursOverride ? Math.round(goalRace.expectedHoursOverride * 3600) : null;
  useEffect(() => {
    if (!isGoalCourse) return;
    // Only when it differs, so a half-typed time isn't rewritten.
    setTargetTimeInput((text) => (parseDurationToSeconds(text) === goalTargetS ? text : goalTargetS ? formatDuration(goalTargetS) : ""));
  }, [isGoalCourse, goalTargetS]);

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
  // While another tab is showing, nothing here is visible, so there's
  // nothing to show a fresh solve to. Frozen at the last computed value (by
  // reference) while frozen is true, so this and every downstream memo
  // keyed on solverInputs (solverResult, chosenPacingResult,
  // bestDemonstratedResult, targetTimeResult, chartPoints,
  // planSummaryStats) skip the whole theta-bisection cascade for every
  // keystroke made in Settings, not just the fields that don't feed it.
  // Catches up in one solve, using whatever the final formInputs ended up
  // being, the moment this tab shows again (frozen flipping is itself a
  // dependency below).
  const lastSolverInputsRef = useRef<SolverInputs | null>(null);
  const solverInputs = useMemo<SolverInputs | null>(() => {
    if (frozen) return lastSolverInputsRef.current;
    if (!courseResult || courseResult.segments.length === 0) {
      lastSolverInputsRef.current = null;
      return null;
    }
    const built = buildSolverInputs(courseResult.segments, formInputs);
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
    frozen,
    courseResult,
    formInputs.bodyMassKg,
    formInputs.vo2MaxHistory,
    formInputs.lt1Fraction,
    formInputs.lt2Fraction,
    formInputs.lt1PaceMinPerKm,
    formInputs.lt2PaceMinPerKm,
    formInputs.walkMaxMs,
    formInputs.fatOxPoints,
    formInputs.durabilityDriftPerHour,
    formInputs.foPeakGPerMin,
    formInputs.intakeGPerH,
    formInputs.glycogenGPerKg,
    formInputs.forceWalkAboveGrade,
    formInputs.altitudeAdjustment,
    formInputs.anaerobicCapacityMin,
    formInputs.unpavedCostMultiplier,
    formInputs.surfaceCostMultipliers,
    formInputs.descentCapCurve,
  ]);

  // Even-paced, NOT findSustainableTheta. That one holds a constant fraction
  // of a ceiling evaluated at each segment's own elapsed time, so the target
  // power decays monotonically through the race and the plan is front-loaded
  // by construction -- on a dead-flat marathon it opened at the athlete's
  // few-minute power and faded to their three-hour power with no terrain
  // involved. It also never charges for going out too hard, which is why it
  // returned a FASTER total than even pacing; real pacing science has even
  // pacing optimal beyond a couple of minutes. And the fitted power-law
  // ceiling is a between-race curve (total duration -> fraction sustained),
  // so applying it as a within-race decay was a category error.
  // "Chosen pacing" and "Best demonstrated" below already used this solver;
  // this puts the zero-margin ceiling on the same footing.
  const solverResult = useMemo(() => {
    if (!solverInputs) return null;
    const flat = findFlatPacedFinishTime(solverInputs);
    // theta 1 by construction: findFlatPacedFinishTime with no margin curve
    // simulates at theta=1 against the flat-duration ceiling, so this is the
    // zero-margin ceiling in the same sense as before.
    return { theta: 1, result: flat.result };
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

  // Shared by both chart-point builders below -- undefined (not applied)
  // whenever no HR-effort calibration has been fit yet, so estimated HR
  // simply doesn't appear rather than showing a meaningless number.
  // Same freeze as solverInputs/analysisInputs above -- feeds chartPoints's
  // own dependency array, so an unnecessary new reference here would still
  // re-run buildChartPoints on every keystroke in Settings even with
  // solverInputs itself frozen.
  const lastHrEstimateInputsRef = useRef<HrEstimateInputs | undefined>(undefined);
  const hrEstimateInputs = useMemo<HrEstimateInputs | undefined>(() => {
    if (frozen) return lastHrEstimateInputsRef.current;
    if (formInputs.hrPowerCalibrationSlope === null || formInputs.hrPowerCalibrationIntercept === null) {
      lastHrEstimateInputsRef.current = undefined;
      return undefined;
    }
    const built: HrEstimateInputs = {
      calibration: {
        slope: formInputs.hrPowerCalibrationSlope,
        intercept: formInputs.hrPowerCalibrationIntercept,
        rSquared: 0,
        pointCount: 0,
        raceCount: 0,
      },
    };
    lastHrEstimateInputsRef.current = built;
    return built;
    // Narrow field list -- see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen, formInputs.hrPowerCalibrationSlope, formInputs.hrPowerCalibrationIntercept]);

  const targetTimeS = useMemo(() => parseDurationToSeconds(targetTimeInput), [targetTimeInput]);

  // Persists the athlete's own target override per-course, same
  // "write back whenever it changes" pattern as savedPointsKm above --
  // keyed on the PARSED value, not targetTimeInput's raw text, so
  // intermediate keystrokes that don't yet parse to a full time (which all
  // resolve to the same null) don't each trigger a write.
  useEffect(() => {
    if (!currentCourseId) return;
    void updateStoredCourseCheckpoints(currentCourseId, { targetTimeS });
    // The goal race's time (which re-plans) follows once typing pauses,
    // not on every keystroke: "12:" already parses as 12 h.
    const timer = setTimeout(() => {
      planSettingsStore.set((st) => {
        const goal = st.goalRace;
        if (!goal || goal.courseId !== currentCourseId) return st;
        const hours = targetTimeS ? targetTimeS / 3600 : null;
        return Math.round((goal.expectedHoursOverride ?? 0) * 3600) === Math.round((hours ?? 0) * 3600) ? st : { ...st, goalRace: { ...goal, expectedHoursOverride: hours } };
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [currentCourseId, targetTimeS]);

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
  // The descent cap the histogram's "braking" flag compares against is
  const planGradeBins = useMemo(
    () => buildGradeHistogram(chartPoints),
    [chartPoints],
  );

  // Same "another tab is showing, nothing to show a fresh rebuild to"
  // freeze as solverInputs above.
  const lastAnalysisInputsRef = useRef<AnalysisInputs | null>(null);
  const analysisInputs = useMemo<AnalysisInputs | null>(() => {
    if (frozen) return lastAnalysisInputsRef.current;
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
    frozen,
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

  const analysisSummaryStats = useMemo(() => summarizeChartPoints(analysisChartPoints), [analysisChartPoints]);
  const analysisGradeBins = useMemo(
    () =>
      buildGradeHistogram(analysisChartPoints),
    [analysisChartPoints],
  );

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
        if (heartRateBpm !== null && formInputs.hrPowerCalibrationSlope !== null && formInputs.hrPowerCalibrationIntercept !== null) {
          const powerWPerKg = predictPowerFromHr(heartRateBpm, {
            slope: formInputs.hrPowerCalibrationSlope,
            intercept: formInputs.hrPowerCalibrationIntercept,
            rSquared: 0,
            pointCount: 0,
            raceCount: 0,
          });
          calibratedPowerW = powerWPerKg * formInputs.bodyMassKg;
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

  const noCourse = (
    <div className="card empty-state">
      <div className="empty-state__art">
        <MapTrifold size={40} weight="duotone" aria-hidden="true" />
      </div>
      <h2>No course open</h2>
      <p>Pick one of your courses, or add a new one.</p>
      <button type="button" className="button-primary" onClick={() => onSegmentChange("course")}>
        Go to courses
      </button>
    </div>
  );

  return (
    <div className="race-tab">
      <div className="segmented" role="tablist" aria-label="Race planner">
        {RACE_SEGMENTS.map((seg) => (
          <button
            key={seg.id}
            type="button"
            role="tab"
            aria-selected={segment === seg.id}
            className={segment === seg.id ? "segmented__item segmented__item--active" : "segmented__item"}
            onClick={() => onSegmentChange(seg.id)}
          >
            {seg.label}
          </button>
        ))}
      </div>

      {[
          {
            id: "course",
            content: (
              <>
                <GoalRaceCard
                  formInputs={formInputs}
                  plan={plan}
                  refreshKey={courseLibraryVersion}
                  onOpenPacing={(course) => {
                    loadCourse(course.points, course.name, course.id, course.savedPointsKm, course.targetTimeS);
                    onSegmentChange("pacing");
                  }}
                />
                <CourseLibraryPanel
                  refreshKey={courseLibraryVersion}
                  onSelect={(course) => {
                    loadCourse(course.points, course.name, course.id, course.savedPointsKm, course.targetTimeS);
                    onSegmentChange("pacing");
                  }}
                  onAdd={() => setAddCourseOpen(true)}
                />
                <FuelingFields values={formInputs} onChange={setFormInputs} />
              </>
            ),
          },
          {
            id: "pacing",
            content: (
              <>
                {!courseResult && noCourse}
                {courseResult && solverResult && (
                  <>
                    <div className="card target-card">
                      <label className="form-row">
                        <span>{isGoalCourse ? "Your finish time" : "Target finish"}</span>
                        <span className="input-unit">
                          <input type="text" inputMode="numeric" placeholder="H:MM" value={targetTimeInput} onChange={(e) => setTargetTimeInput(e.target.value)} />
                          {targetTimeInput && (
                            <button type="button" className="link-button" onClick={() => setTargetTimeInput("")}>
                              Clear
                            </button>
                          )}
                        </span>
                      </label>
                      {targetTimeInput && targetTimeS === null ? (
                        <p className="help danger">Enter a time as H:MM or H:MM:SS.</p>
                      ) : (
                        <p className="help">
                          {isGoalCourse
                            ? "Pacing, splits and fuel below follow it, and it sizes your training plan (same as the time on the race card)."
                            : "Pacing, splits and fuel below follow it."}
                        </p>
                      )}
                    </div>
                    <ResultsSummary
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
                    <RouteMap
                      routePoints={courseResult.routePoints}
                      splitPoints={chartPoints}
                      highlightedDistanceKm={highlightedDistanceKm}
                      onHighlight={setHighlightedDistanceKm}
                      savedPointsKm={savedPointsKm}
                      onSavePoint={saveHighlightedPoint}
                      onRemoveSavedPoint={removeSavedPoint}
                      onClearSavedPoints={clearSavedPoints}
                    />
                    {/* A handful of segments (e.g. an immediate bonk) isn't
                        enough for a meaningful chart axis/scale. */}
                    {chartPoints.length >= 5 && (
                      <>
                        {targetTimeResult && targetTimeS !== null && (
                          <p className="help">
                            Splits and charts below show your {formatDuration(targetTimeS)} target
                            {Math.abs(targetTimeResult.result.finishTimeS - targetTimeS) > 60
                              ? " (closest achievable pace, not exact)"
                              : ""}
                            . Clear it to go back to the theoretical ceiling.
                          </p>
                        )}
                        <ElevationProfileChart
                          points={chartPoints}
                          highlightedDistanceKm={highlightedDistanceKm}
                          savedPointsKm={savedPointsKm}
                          onPointClick={setHighlightedDistanceKm}
                        />
                        <GradeHistogram bins={planGradeBins} />
                        <FuelChart points={chartPoints} />
                        <SplitTable
                          points={chartPoints}
                          splitLengthKm={formInputs.splitLengthKm}
                          onSplitLengthChange={(splitLengthKm) => setFormInputs((prev) => ({ ...prev, splitLengthKm }))}
                          savedPointsKm={savedPointsKm}
                          onClearSavedPoints={clearSavedPoints}
                          intakeGPerH={formInputs.intakeGPerH}
                        />
                      </>
                    )}
                  </>
                )}
              </>
            ),
          },
          {
            id: "analyze",
            content: (
              <>
                {!courseResult && noCourse}
                {courseResult && !courseResult.hasTimestamps && (
                  <div className="banner banner--warning">
                    <Warning size={20} weight="duotone" aria-hidden="true" />
                    <p>This course has no times in it. Analyze needs a recorded run: add one from Strava or a GPX file from your watch.</p>
                  </div>
                )}
                {courseResult && analysisResult && (
                  <>
                    <AnalysisSummary result={analysisResult} totalDistanceM={courseResult.totalDistance3D} summaryStats={analysisSummaryStats} />
                    <RouteMap
                      routePoints={courseResult.routePoints}
                      splitPoints={analysisChartPoints}
                      highlightedDistanceKm={highlightedDistanceKm}
                      onHighlight={setHighlightedDistanceKm}
                      savedPointsKm={savedPointsKm}
                      onSavePoint={saveHighlightedPoint}
                      onRemoveSavedPoint={removeSavedPoint}
                      onClearSavedPoints={clearSavedPoints}
                    />
                    {analysisChartPoints.length >= 5 && (
                      <>
                        <ElevationProfileChart
                          points={analysisChartPoints}
                          highlightedDistanceKm={highlightedDistanceKm}
                          savedPointsKm={savedPointsKm}
                          onPointClick={setHighlightedDistanceKm}
                        />
                        <GradeHistogram bins={analysisGradeBins} />
                        {solverResult && (
                          <PaceEffortChart
                            actual={paceEffortActualPoints}
                            planned={paceEffortPlannedPoints}
                            plannedThetaFraction={solverResult.theta}
                            highlightedDistanceKm={highlightedDistanceKm}
                          />
                        )}
                        {(courseResult.hasPower || courseResult.hasHeartRate) && (
                          <PowerHrChart
                            points={powerHrPoints}
                            hasPower={courseResult.hasPower}
                            hasHeartRate={courseResult.hasHeartRate}
                            hasCalibratedPower={
                              courseResult.hasHeartRate &&
                              formInputs.hrPowerCalibrationSlope !== null &&
                              formInputs.hrPowerCalibrationIntercept !== null
                            }
                          />
                        )}
                        <FuelChart points={analysisChartPoints} />
                        <SubstrateChart points={substratePoints} />
                        <SplitTable
                          points={analysisChartPoints}
                          splitLengthKm={formInputs.splitLengthKm}
                          onSplitLengthChange={(splitLengthKm) => setFormInputs((prev) => ({ ...prev, splitLengthKm }))}
                          savedPointsKm={savedPointsKm}
                          onClearSavedPoints={clearSavedPoints}
                          intakeGPerH={formInputs.intakeGPerH}
                        />
                        {analysisInputs && (
                          <PacingFitPanel
                            points={pacingFitPoints}
                            ceilingParams={analysisInputs.ceilingParams ?? {}}
                            onApplyDrift={(durabilityDriftPerHour) =>
                              setFormInputs((prev) => ({ ...prev, durabilityDriftPerHour }))
                            }
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            ),
          },
        ]
        .filter((page) => page.id === segment)
        .map((page) => (
          <section key={page.id} className="race-tab__page" role="tabpanel">
            {page.content}
          </section>
        ))}

      <AddCoursePanel
        open={addCourseOpen}
        onClose={() => setAddCourseOpen(false)}
        onCourseLoaded={(points, name, stravaId) => {
          setRawPoints(points);
          setFileName(name);
          // Clears currentCourseId (not just savedPointsKm/targetTimeInput)
          // so the persistence effects above don't write this fresh
          // course's empty state into the PREVIOUS course's row during the
          // gap before saveCourse resolves below -- see loadCourse's own
          // doc on why reset and course-id changes have to land together.
          setCurrentCourseId(null);
          setHighlightedDistanceKm(null);
          setSavedPointsKm([]);
          setTargetTimeInput("");
          void saveCourse(name, points, stravaId !== undefined ? `strava:${stravaId}` : undefined).then((saved) => {
            setCourseLibraryVersion((v) => v + 1);
            setCurrentCourseId(saved.id);
            // A stable (Strava) id can resolve to a row that already had
            // aid-station points/a target saved from a previous import --
            // restore them now that we know. A fresh plain-upload id never
            // has either, so this is a no-op for that case.
            if (saved.savedPointsKm && saved.savedPointsKm.length > 0) setSavedPointsKm(saved.savedPointsKm);
            if (saved.targetTimeS != null) setTargetTimeInput(formatDuration(saved.targetTimeS));
          });
        }}
        formInputs={formInputs}
        onFormInputsChange={setFormInputs}
        courseResult={courseResult}
        fileName={fileName}
        rawStats={rawStats}
        debugProcessedPoints={debugProcessedPoints}
      />
    </div>
  );
}

