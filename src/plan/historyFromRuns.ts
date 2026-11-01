// Turns the app's stored runs (storage/runLibrary.ts) into the plan
// generator's history and options, in the browser. Runs with points get
// the points-based mechanical load, descent and steep descent; summary-only
// runs (and runs whose elevation is implausible: points-based load more
// than 1.5x the summary estimate) fall back to activityLoadFromSummary.
// Mechanical load needs no physiology, so nothing here depends on the
// athlete's settings.

import { runPipeline, type CourseSegment } from "../gpx/pipeline";
import { descentMeters, STEEP_DESCENT_GRADE, steepDescentMeters } from "../model/descentImpact";
import { runningImpact } from "../model/runningImpact";
import type { StoredRun, TreadmillLap } from "../storage/runLibrary";
import { activityLoadFromSummary, localDateKey } from "./loadLedger";
import type { HistoryRun, PlanOptions } from "./planGenerator";

export interface DatedHistoryRun extends HistoryRun {
  /** Local date, YYYY-MM-DD. */
  date: string;
  runId: string;
  /** "laps": a treadmill run with its lap grades entered. */
  source: "points" | "summary" | "laps";
  /** Moving-time average of the recorded heart rate, if any. */
  avgHrBpm?: number;
}

export const dayNumberOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 864e5;
export const dateOfDayNumber = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);

/** Null for a run with neither a date nor timestamps, or no distance. */
export function historyRunFromStored(run: StoredRun, timeZone: string): DatedHistoryRun | null {
  const firstTime = run.points?.find((p) => p.time)?.time ?? null;
  const instant = run.date ? new Date(run.date) : firstTime;
  if (!instant) return null;
  const date = localDateKey(instant, timeZone);
  const course = run.points && run.points.length > 1 ? runPipeline(run.points) : null;
  const distanceKm = run.distanceKm ?? (course ? course.totalDistance3D / 1000 : 0);
  let movingS = run.durationS ?? 0;
  if (!movingS && course?.hasTimestamps) movingS = course.segments.reduce((s, x) => s + (!x.paused && x.dtS ? x.dtS : 0), 0);
  if (!(distanceKm > 0) || !(movingS > 0)) return null;
  const gain = run.elevationGainM ?? course?.totalElevationGain ?? 0;
  const summary = activityLoadFromSummary({ activityId: run.id, date, distanceKm, elevationGainM: gain, movingS, thresholdGrossPowerWPerKg: 15 });
  const base = { day: dayNumberOf(date), date, runId: run.id, movingMin: movingS / 60, distanceKm };
  if (!course && run.treadmillLaps?.length) return { ...base, ...treadmillLoad(run.treadmillLaps), source: "laps" };
  if (course?.hasElevation) {
    const mechanical = runningImpact(course.segments);
    if (!(summary.mechanical > 0 && mechanical / summary.mechanical > 1.5)) {
      const avgHrBpm = averageHeartRate(course.segments);
      return {
        ...base, mechanical, descentM: descentMeters(course.segments), steepDescentM: steepDescentMeters(course.segments), climbM: course.totalElevationGain, source: "points",
        ...(avgHrBpm !== null ? { avgHrBpm } : {}),
      };
    }
  }
  return { ...base, mechanical: summary.mechanical, descentM: summary.descentM, steepDescentM: summary.steepDescentM, climbM: gain, source: "summary" };
}

/** Moving-time average heart rate over the segments that have one; null
 * under half the moving time covered. */
export function averageHeartRate(segments: Pick<CourseSegment, "heartRateBpm" | "dtS" | "paused">[]): number | null {
  let t = 0;
  let sum = 0;
  let moving = 0;
  for (const s of segments) {
    if (s.paused || !s.dtS) continue;
    moving += s.dtS;
    if (s.heartRateBpm && s.heartRateBpm > 0) {
      t += s.dtS;
      sum += s.heartRateBpm * s.dtS;
    }
  }
  return t > 0 && t >= moving / 2 ? sum / t : null;
}

/** Assumption: runs this long or longer count as long runs, and the last
 * this-many days of them say what a normal long run is. */
const LONG_RUN_MIN_MINUTES = 75;
const LONG_RUN_HR_DAYS = 90;

/**
 * The athlete's normal long-run heart rate: the median of the recent long
 * runs' averages (races left out), or null with fewer than two. Where the
 * plan's race-effort long runs start from (ui/plan/intensity.ts).
 */
export function longRunHeartRate(history: Pick<DatedHistoryRun, "day" | "movingMin" | "avgHrBpm" | "runId">[], today: number, raceRunIds: ReadonlySet<string> = new Set()): number | null {
  const hrs = history
    .filter((r) => r.day < today && r.day >= today - LONG_RUN_HR_DAYS && r.movingMin >= LONG_RUN_MIN_MINUTES && r.avgHrBpm && !raceRunIds.has(r.runId))
    .map((r) => r.avgHrBpm!)
    .sort((a, b) => a - b);
  if (hrs.length < 2) return null;
  const m = hrs.length >> 1;
  return hrs.length % 2 ? hrs[m] : (hrs[m - 1] + hrs[m]) / 2;
}

/**
 * Climb, descent and load of a treadmill run from its laps' grades. The
 * belt measures along-slope distance, so a lap of d m at grade g rises
 * d g / sqrt(1 + g^2). The load is runningImpact on one segment per lap
 * (not runPipeline, whose smoothing would blur the grade changes).
 */
export function treadmillLoad(laps: TreadmillLap[]): Pick<HistoryRun, "mechanical" | "descentM" | "steepDescentM" | "climbM"> {
  let climbM = 0;
  let descentM = 0;
  let steepDescentM = 0;
  let cumulative = 0;
  let elevation = 0;
  const segments: CourseSegment[] = laps.map((lap, index) => {
    const g = lap.gradePct / 100;
    const horizontal = lap.distanceM / Math.sqrt(1 + g * g);
    const rise = horizontal * g;
    if (rise > 0) climbM += rise;
    else {
      descentM -= rise;
      if (g < STEEP_DESCENT_GRADE) steepDescentM -= rise;
    }
    cumulative += lap.distanceM;
    elevation += rise;
    return {
      index, cumulativeDistance3D: cumulative, distanceHorizontal: horizontal, distance3D: lap.distanceM, elevation, gradient: g,
      time: null, dtS: lap.movingS, paused: false, heartRateBpm: null, powerWatts: null,
    };
  });
  return { mechanical: runningImpact(segments), descentM, steepDescentM, climbM };
}

/** Typical values for a generic athlete, used until enough runs have points. */
const GENERIC_OPTIONS: PlanOptions = { easyDensity: 70, maxDensity: 85, speedKmh: 9, maxDescentPerHour: 300, maxSteepDescentPerHour: 100 };
export const MIN_RUNS_FOR_OWN_OPTIONS = 20;

/** True when planOptionsFromHistory falls back to the generic values. */
export const usesGenericPlanOptions = (history: DatedHistoryRun[]) =>
  history.filter((r) => r.source === "points" && r.movingMin >= 30).length < MIN_RUNS_FOR_OWN_OPTIONS;

/** Hills per hour may be this much more than the last 30 days' (their
 * 90th percentile), like the other hill limits' weekly step. */
const HILLS_PER_HOUR_STEP = 1.1;
const RECENT_DAYS = 30;

/** The generator's density, speed and descent options from the athlete's
 * own points-based runs of 30+ min: median and 90th-percentile load per
 * hour, median speed, 90th-percentile descent and steep descent per hour.
 * The hill rates are the larger of all runs' and 10% over the last 30
 * days', so they grow as the athlete runs hillier. */
export function planOptionsFromHistory(history: DatedHistoryRun[], today?: number): PlanOptions {
  const pts = history.filter((r) => r.source === "points" && r.movingMin >= 30);
  if (pts.length < MIN_RUNS_FOR_OWN_OPTIONS) return GENERIC_OPTIONS;
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const perHour = (f: (r: DatedHistoryRun) => number, runs = pts) => runs.map((r) => f(r) / (r.movingMin / 60));
  const recent = today === undefined ? [] : pts.filter((r) => r.day >= today - RECENT_DAYS && r.day < today);
  const hills = (f: (r: DatedHistoryRun) => number) =>
    Math.max(q(perHour(f), 0.9), recent.length ? HILLS_PER_HOUR_STEP * q(perHour(f, recent), 0.9) : 0);
  return {
    easyDensity: q(perHour((r) => r.mechanical), 0.5),
    maxDensity: q(perHour((r) => r.mechanical), 0.9),
    speedKmh: q(perHour((r) => r.distanceKm), 0.5),
    maxDescentPerHour: hills((r) => r.descentM),
    maxSteepDescentPerHour: hills((r) => r.steepDescentM),
    maxClimbPerHour: hills((r) => r.climbM),
  };
}
