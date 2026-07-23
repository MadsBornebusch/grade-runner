// PLAN.md §14 Plan B, Stage 2: splits a course's fixed-length pipeline
// segments (CourseSegment[], already resampled to segmentLengthM) into
// variable-length runs that are monotonic in grade sign, constant in
// surface category, and constant in gait -- the units the slowdown-factor
// regression will bin and fit on. Pure function, no I/O; verified against a
// synthetic course in monotonicSegments.test.ts before any real data, same
// discipline as every other mechanism in this file.
//
// Also computes, per resulting segment, the internal-state candidates
// evaluated AT THE START of that segment -- i.e. reflecting everything
// before it, not including its own contribution -- matching pacingFit.ts's
// EffortTrendPoint convention elsewhere in this codebase:
// - aerobic-fatigue candidates (§14 fatigue-proxy shortlist): elapsed time,
//   cumulative net work, cumulative supra-LT2 "hard" work. W'-balance is
//   deliberately NOT implemented here yet (§14 flags it as needing its own
//   recovery-time-constant fit, real added complexity).
// - impact/muscular-fatigue candidates (§14's second internal channel,
//   cost-side rather than ceiling-side): the same three descent-exposure
//   bases already validated in descentImpact.ts and used by the whole-race
//   fits (pacingFit.ts, ceiling.ts's durabilityDriftPerDescentUnit) --
//   reused via descentStepForSegment rather than reimplemented a fourth
//   time, per that module's own stated reason for existing.

import type { CourseSegment, SurfaceCategory } from "../gpx/pipeline";
import { costOfRunning, costOfWalking } from "./minetti";
import { netToGross } from "./energetics";
import { type CeilingParams, maxAerobicPower } from "./ceiling";
import { descentStepForSegment } from "./descentImpact";

export type GradeSign = -1 | 0 | 1;
export type GaitMode = "run" | "walk";

export interface MonotonicSegmentOptions {
  /** Dead zone around zero grade so GPS/elevation noise doesn't flicker the
   * sign back and forth on a genuinely flat stretch. Default 0.015 (1.5%). */
  gradeHysteresisFraction?: number;
  /** Same convention as solver.ts/analysis.ts: speed at or below this is
   * walking gait. Default 2.0 m/s. */
  walkMaxMs?: number;
  /** A candidate run must clear EITHER this distance OR the time floor
   * below to be kept -- PLAN.md §14: "~100m or ~30s, whichever binds",
   * roughly 2x the pipeline's own default 50m resample spacing so a kept
   * segment always spans several underlying points. */
  minDistanceM?: number;
  minTimeS?: number;
  /** Needed to convert device powerWatts into W/kg for avgMeasuredPowerWPerKg
   * -- omitted (default) means that field is always null. */
  bodyMassKg?: number;
  /**
   * Presence (not value) gates whether cumulativeHardWorkJPerKgAtStart is
   * computed at all -- an explicit opt-in (even `{}`) rather than silently
   * defaulting, since a generic default LT2/VO2max doesn't represent a
   * specific athlete. When provided, altitude-adjusts the LT2 power
   * reference per segment via the segment's own elevation, same as
   * ceilingPower does elsewhere.
   */
  ceilingParams?: CeilingParams;
}

export interface MonotonicSegment {
  /** Index range into the original CourseSegment[] this run was built from (inclusive). */
  startIndex: number;
  endIndex: number;
  distance3D: number;
  timeS: number;
  avgSpeedMs: number;
  /** Distance-weighted average gradient across the underlying points. */
  avgGradient: number;
  gradeSign: GradeSign;
  /** Undefined iff no underlying point had surface data attached. */
  surfaceCategory: SurfaceCategory | undefined;
  gaitMode: GaitMode;
  /** Average of powerWatts/bodyMassKg across underlying points that had
   * device power. Null if bodyMassKg wasn't supplied or no point in this
   * run had power data at all -- distinct from a low-but-nonzero coverage. */
  avgMeasuredPowerWPerKg: number | null;
  /** Fraction (0..1) of underlying points that had device power -- lets a
   * caller distinguish "no power at all" from "power on part of this run". */
  measuredPowerCoverage: number;
  /** Minetti-implied gross power/kg, averaged per underlying point (not
   * computed from the segment's own averaged gradient/speed, since the cost
   * curve is nonlinear) -- always available, model-derived. */
  avgMinettiGrossPowerWPerKg: number;
  /** Internal-state candidates evaluated at the START of this segment (
   * before its own distance/time/work), matching EffortTrendPoint's
   * existing convention elsewhere in this codebase. */
  cumulativeElapsedHoursAtStart: number;
  cumulativeDistanceMAtStart: number;
  /** Minetti-derived net locomotion work so far, J/kg. */
  cumulativeNetWorkJPerKgAtStart: number;
  /** Cumulative supra-LT2 ("hard") work so far, J/kg -- null unless
   * ceilingParams was supplied (see that option's own doc). */
  cumulativeHardWorkJPerKgAtStart: number | null;
  /** Impact/muscular-fatigue candidates -- three parallel readings of
   * cumulative descent exposure so far (raw meters, meters x speed, meters
   * x speed^2), same three bases as descentImpact.ts/EffortTrendPoint.
   * Always computed (no opt-in needed -- unlike cumulativeHardWork, these
   * need no athlete-specific params, only the course's own elevation and
   * pace). See descentStepForSegment for the exact elevation-delta/pause
   * exclusion rules. */
  cumulativeDescentMAtStart: number;
  cumulativeDescentImpactAtStart: number;
  cumulativeDescentImpactSquaredAtStart: number;
}

const DEFAULT_GRADE_HYSTERESIS_FRACTION = 0.015;
const DEFAULT_WALK_MAX_MS = 2.0;
const DEFAULT_MIN_DISTANCE_M = 100;
const DEFAULT_MIN_TIME_S = 30;
/** Matches ceiling.ts's own DEFAULTS.lt2Fraction -- not exported there, so
 * duplicated here rather than threading an extra export through for one
 * constant. Only used when ceilingParams is supplied without its own
 * lt2Fraction. */
const DEFAULT_LT2_FRACTION = 0.85;

function gradeSignWithHysteresis(gradient: number, previous: GradeSign, hysteresisFraction: number): GradeSign {
  if (gradient > hysteresisFraction) return 1;
  if (gradient < -hysteresisFraction) return -1;
  return previous;
}

interface Accumulator {
  startIndex: number;
  endIndex: number;
  distance3D: number;
  timeS: number;
  gradeWeightedSum: number;
  gradeSign: GradeSign;
  surfaceCategory: SurfaceCategory | undefined;
  gaitMode: GaitMode;
  measuredPowerSum: number;
  measuredPowerCount: number;
  minettiPowerSum: number;
  pointCount: number;
  elapsedHoursAtStart: number;
  distanceMAtStart: number;
  netWorkJPerKgAtStart: number;
  hardWorkJPerKgAtStart: number | null;
  descentMAtStart: number;
  descentImpactAtStart: number;
  descentImpactSquaredAtStart: number;
}

/**
 * Splits `segments` into monotonic-grade/constant-surface/constant-gait
 * runs. A run breaks whenever grade sign (with hysteresis), surface
 * category, or gait changes, and always at a paused or untimed segment
 * (which is itself dropped, not included in any run either side of it --
 * two runs separated by a pause aren't contiguous, regardless of whether
 * grade/surface/gait would otherwise match). Short runs that clear neither
 * the distance nor time floor are dropped, not merged into a neighbor.
 */
export function buildMonotonicSegments(
  segments: CourseSegment[],
  options: MonotonicSegmentOptions = {},
): MonotonicSegment[] {
  const hysteresisFraction = options.gradeHysteresisFraction ?? DEFAULT_GRADE_HYSTERESIS_FRACTION;
  const walkMaxMs = options.walkMaxMs ?? DEFAULT_WALK_MAX_MS;
  const minDistanceM = options.minDistanceM ?? DEFAULT_MIN_DISTANCE_M;
  const minTimeS = options.minTimeS ?? DEFAULT_MIN_TIME_S;
  const bodyMassKg = options.bodyMassKg;
  const hardWorkEnabled = options.ceilingParams !== undefined;
  const ceilingParams = options.ceilingParams ?? {};
  const lt2Fraction = ceilingParams.lt2Fraction ?? DEFAULT_LT2_FRACTION;

  const result: MonotonicSegment[] = [];
  let current: Accumulator | null = null;
  let previousSign: GradeSign = 0;

  let cumulativeElapsedHours = 0;
  let cumulativeDistanceM = 0;
  let cumulativeNetWorkJPerKg = 0;
  let cumulativeHardWorkJPerKg: number | null = hardWorkEnabled ? 0 : null;
  let cumulativeDescentM = 0;
  let cumulativeDescentImpact = 0;
  let cumulativeDescentImpactSquared = 0;
  /** Previous segment's own elevation, in course order -- descentStepForSegment's
   * contract requires this be threaded across EVERY segment (paused or not),
   * unconditionally, same as pacingFit.ts/solver.ts already do. */
  let previousElevation: number | null = null;

  function finalizeCurrent(): void {
    if (current === null) return;
    const c = current;
    if (c.distance3D >= minDistanceM || c.timeS >= minTimeS) {
      result.push({
        startIndex: c.startIndex,
        endIndex: c.endIndex,
        distance3D: c.distance3D,
        timeS: c.timeS,
        avgSpeedMs: c.distance3D / c.timeS,
        avgGradient: c.gradeWeightedSum / c.distance3D,
        gradeSign: c.gradeSign,
        surfaceCategory: c.surfaceCategory,
        gaitMode: c.gaitMode,
        avgMeasuredPowerWPerKg: c.measuredPowerCount > 0 ? c.measuredPowerSum / c.measuredPowerCount : null,
        measuredPowerCoverage: c.pointCount > 0 ? c.measuredPowerCount / c.pointCount : 0,
        avgMinettiGrossPowerWPerKg: c.minettiPowerSum / c.pointCount,
        cumulativeElapsedHoursAtStart: c.elapsedHoursAtStart,
        cumulativeDistanceMAtStart: c.distanceMAtStart,
        cumulativeNetWorkJPerKgAtStart: c.netWorkJPerKgAtStart,
        cumulativeHardWorkJPerKgAtStart: c.hardWorkJPerKgAtStart,
        cumulativeDescentMAtStart: c.descentMAtStart,
        cumulativeDescentImpactAtStart: c.descentImpactAtStart,
        cumulativeDescentImpactSquaredAtStart: c.descentImpactSquaredAtStart,
      });
    }
    current = null;
  }

  for (const seg of segments) {
    const dt = seg.dtS;
    const usable = !seg.paused && dt !== null && dt > 0;

    // Must run for EVERY segment, in course order, regardless of usability --
    // descentStepForSegment's own contract (paused/untimed/climbing segments
    // already resolve to a zero contribution internally, so this is a no-op
    // in the `!usable` branch below, not a special case to guard against).
    const descentStep = descentStepForSegment(seg, previousElevation);
    previousElevation = seg.elevation;

    if (!usable) {
      finalizeCurrent();
      if (dt !== null && dt > 0) cumulativeElapsedHours += dt / 3600; // pause time still counts as elapsed wall-clock (ceiling.ts's own convention)
      previousSign = 0; // don't carry stale grade-direction memory across a real gap
      continue;
    }

    const speedMs = seg.distance3D / dt;
    const sign = gradeSignWithHysteresis(seg.gradient, previousSign, hysteresisFraction);
    previousSign = sign;
    const gaitMode: GaitMode = speedMs <= walkMaxMs ? "walk" : "run";
    const surfaceCategory = seg.surfaceCategory;

    if (current !== null && (current.gradeSign !== sign || current.surfaceCategory !== surfaceCategory || current.gaitMode !== gaitMode)) {
      finalizeCurrent();
    }

    const cost = gaitMode === "walk" ? costOfWalking(seg.gradient) : costOfRunning(seg.gradient);
    const netWorkJPerKg = cost * seg.distance3D;
    const grossPowerWPerKg = netToGross(cost * speedMs);
    const hardWorkJPerKg = hardWorkEnabled
      ? Math.max(0, grossPowerWPerKg - maxAerobicPower(seg.elevation, ceilingParams) * lt2Fraction) * dt
      : null;

    if (current === null) {
      current = {
        startIndex: seg.index,
        endIndex: seg.index,
        distance3D: 0,
        timeS: 0,
        gradeWeightedSum: 0,
        gradeSign: sign,
        surfaceCategory,
        gaitMode,
        measuredPowerSum: 0,
        measuredPowerCount: 0,
        minettiPowerSum: 0,
        pointCount: 0,
        elapsedHoursAtStart: cumulativeElapsedHours,
        distanceMAtStart: cumulativeDistanceM,
        netWorkJPerKgAtStart: cumulativeNetWorkJPerKg,
        hardWorkJPerKgAtStart: cumulativeHardWorkJPerKg,
        descentMAtStart: cumulativeDescentM,
        descentImpactAtStart: cumulativeDescentImpact,
        descentImpactSquaredAtStart: cumulativeDescentImpactSquared,
      };
    }

    current.endIndex = seg.index;
    current.distance3D += seg.distance3D;
    current.timeS += dt;
    current.gradeWeightedSum += seg.gradient * seg.distance3D;
    current.pointCount += 1;
    current.minettiPowerSum += grossPowerWPerKg;
    if (seg.powerWatts !== null && bodyMassKg !== undefined) {
      current.measuredPowerSum += seg.powerWatts / bodyMassKg;
      current.measuredPowerCount += 1;
    }

    cumulativeElapsedHours += dt / 3600;
    cumulativeDistanceM += seg.distance3D;
    cumulativeNetWorkJPerKg += netWorkJPerKg;
    if (cumulativeHardWorkJPerKg !== null && hardWorkJPerKg !== null) cumulativeHardWorkJPerKg += hardWorkJPerKg;
    if (descentStep.speedMs !== null) {
      cumulativeDescentM += descentStep.descentM;
      cumulativeDescentImpact += descentStep.descentM * descentStep.speedMs;
      cumulativeDescentImpactSquared += descentStep.descentM * descentStep.speedMs * descentStep.speedMs;
    }
  }
  finalizeCurrent();

  return result;
}
