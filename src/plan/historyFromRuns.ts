// Turns the app's stored runs (storage/runLibrary.ts) into the plan
// generator's history and options, in the browser. Runs with points get
// the points-based mechanical load, descent and steep descent; summary-only
// runs (and runs whose elevation is implausible: points-based load more
// than 1.5x the summary estimate) fall back to activityLoadFromSummary.
// Mechanical load needs no physiology, so nothing here depends on the
// athlete's settings.

import { runPipeline } from "../gpx/pipeline";
import { descentMeters, steepDescentMeters } from "../model/descentImpact";
import { runningImpact } from "../model/runningImpact";
import type { StoredRun } from "../storage/runLibrary";
import { activityLoadFromSummary, localDateKey } from "./loadLedger";
import type { HistoryRun, PlanOptions } from "./planGenerator";

export interface DatedHistoryRun extends HistoryRun {
  /** Local date, YYYY-MM-DD. */
  date: string;
  runId: string;
  source: "points" | "summary";
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
  if (course?.hasElevation) {
    const mechanical = runningImpact(course.segments);
    if (!(summary.mechanical > 0 && mechanical / summary.mechanical > 1.5)) {
      return { ...base, mechanical, descentM: descentMeters(course.segments), steepDescentM: steepDescentMeters(course.segments), climbM: course.totalElevationGain, source: "points" };
    }
  }
  return { ...base, mechanical: summary.mechanical, descentM: summary.descentM, steepDescentM: summary.steepDescentM, climbM: gain, source: "summary" };
}

/** Typical values for a generic athlete, used until enough runs have points. */
const GENERIC_OPTIONS: PlanOptions = { easyDensity: 70, maxDensity: 85, speedKmh: 9, maxDescentPerHour: 300, maxSteepDescentPerHour: 100 };
export const MIN_RUNS_FOR_OWN_OPTIONS = 20;

/** True when planOptionsFromHistory falls back to the generic values. */
export const usesGenericPlanOptions = (history: DatedHistoryRun[]) =>
  history.filter((r) => r.source === "points" && r.movingMin >= 30).length < MIN_RUNS_FOR_OWN_OPTIONS;

/** The generator's density, speed and descent options from the athlete's
 * own points-based runs of 30+ min: median and 90th-percentile load per
 * hour, median speed, 90th-percentile descent and steep descent per hour. */
export function planOptionsFromHistory(history: DatedHistoryRun[]): PlanOptions {
  const pts = history.filter((r) => r.source === "points" && r.movingMin >= 30);
  if (pts.length < MIN_RUNS_FOR_OWN_OPTIONS) return GENERIC_OPTIONS;
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const perHour = (f: (r: DatedHistoryRun) => number) => pts.map((r) => f(r) / (r.movingMin / 60));
  return {
    easyDensity: q(perHour((r) => r.mechanical), 0.5),
    maxDensity: q(perHour((r) => r.mechanical), 0.9),
    speedKmh: q(perHour((r) => r.distanceKm), 0.5),
    maxDescentPerHour: q(perHour((r) => r.descentM), 0.9),
    maxSteepDescentPerHour: q(perHour((r) => r.steepDescentM), 0.9),
    maxClimbPerHour: q(perHour((r) => r.climbM), 0.9),
  };
}
