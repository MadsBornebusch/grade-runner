// Shared by the plan backtests (PLAN.md §15 stages 3+): every cached run
// as a ledger row (points-based where points exist, summary otherwise) plus
// its stage-2 fitness index reading, computed with the frozen settings
// (fitnessIndex.ts's FLAT_* and FROZEN_MIN_SAMPLE_MIN, pace-derived power,
// pooled slope, median reference HR, bad-elevation runs excluded).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import { buildEffortTrendPoints } from "../src/model/pacingFit.ts";
import {
  activityLoadFromCourse, activityLoadFromSummary, localDateKey, type ActivityLoad,
} from "../src/plan/loadLedger.ts";
import {
  FLAT_MAX_GRADE, FLAT_WINDOW_S, FROZEN_MIN_SAMPLE_MIN, flatSampleMask, pooledPowerPerBpm, powerAtReferenceHr,
  summarizeRunSamples, type RunHrPowerSummary,
} from "../src/plan/fitnessIndex.ts";
import { athleteCeilingParams, loadAthleteProfile } from "./athleteProfile.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const TIME_ZONE = "Europe/Oslo";

interface Activity { stravaId: number; name: string; date: string; distanceKm: number; durationS: number; elevationGainM: number }

export interface PlanRun {
  id: number;
  name: string;
  date: string;
  /** Days since 1970-01-01 of the local date. */
  day: number;
  movingMin: number;
  distanceKm: number;
  load: ActivityLoad;
  /** Stage-2 fitness summary (null without points, HR, or enough flat time). */
  fitness: RunHrPowerSummary | null;
  /** Points-based mechanical load > 1.5x the summary estimate. */
  badElevation: boolean;
}

export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 864e5;

export function loadPlanRuns(): PlanRun[] {
  const profile = loadAthleteProfile();
  const ceilingParams = athleteCeilingParams(profile);
  const bodyMassKg = profile.form.bodyMassKg;
  const threshold = maxAerobicPower(0, ceilingParams) * (ceilingParams.lt2Fraction ?? 0.85);
  const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Activity[];
  const out: PlanRun[] = [];
  for (const a of activities) {
    const date = localDateKey(new Date(a.date), TIME_ZONE);
    const summary = activityLoadFromSummary({
      activityId: String(a.stravaId), date, distanceKm: a.distanceKm, elevationGainM: a.elevationGainM ?? 0,
      movingS: a.durationS, thresholdGrossPowerWPerKg: threshold,
    });
    let load = summary;
    let fitness: RunHrPowerSummary | null = null;
    let badElevation = false;
    const path = `${CACHE}activity-${a.stravaId}.json`;
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { points: (Omit<GpxPoint, "time"> & { time: string | null })[] };
      const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
      const course = runPipeline(points);
      if (course.hasTimestamps && course.hasElevation) {
        const analysis = analyzeRun(course.segments, { bodyMassKg, ceilingParams, fueling: { intakeGPerH: 0 }, glycogenStoreG: 1e9 });
        load = activityLoadFromCourse({ activityId: String(a.stravaId), date, segments: course.segments, analysis, thresholdGrossPowerWPerKg: threshold });
        badElevation = summary.mechanical > 0 && load.mechanical / summary.mechanical > 1.5;
        if (badElevation) load = summary;
        const hasHr = points.filter((p) => p.hr).length >= 0.8 * points.length;
        if (hasHr && !badElevation && a.durationS >= 30 * 60) {
          const trend = buildEffortTrendPoints(course.segments, analysis.segments, true);
          const trendSegments = analysis.segments.filter((s) => s.effortFraction !== null).map((s) => course.segments[s.index]);
          const flat = flatSampleMask(trend, trendSegments.map((seg) => seg?.gradient ?? 0), FLAT_MAX_GRADE, FLAT_WINDOW_S);
          fitness = summarizeRunSamples(trend, (i) => flat[i], FROZEN_MIN_SAMPLE_MIN);
        }
      }
    }
    out.push({ id: a.stravaId, name: a.name, date, day: dayNumber(date), movingMin: a.durationS / 60, distanceKm: a.distanceKm, load, fitness, badElevation });
  }
  return out.sort((x, y) => x.day - y.day);
}

export interface IndexReading { run: PlanRun; value: number }

/** Stage 2's index for every run with a fitness summary: pooled slope over
 * all of them, reference HR their median mean HR, runs too far from it
 * dropped. The slope and reference use the whole history, a small leak for
 * a backtest (a measurement constant, not the response being tested). */
export function fitnessReadings(runs: PlanRun[]): { readings: IndexReading[]; slope: number; referenceHr: number } {
  const have = runs.filter((r) => r.fitness);
  const slope = pooledPowerPerBpm(have.map((r) => r.fitness!)) ?? 0;
  const hrs = have.map((r) => r.fitness!.meanHr).sort((x, y) => x - y);
  const m = hrs.length >> 1;
  const referenceHr = Math.round(hrs.length % 2 ? hrs[m] : (hrs[m - 1] + hrs[m]) / 2);
  const readings = have.flatMap((run) => {
    const value = powerAtReferenceHr(run.fitness!, slope, referenceHr);
    return value === null ? [] : [{ run, value }];
  });
  return { readings, slope, referenceHr };
}
