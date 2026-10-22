// Gut training on long runs: where the carb ladder starts, from what the
// athlete has logged, and which runs still need a log. The generator's
// carbTargets then steps up from that start toward the race intake.
import { FUELLED_RUN_MINUTES } from "./planGenerator";
import type { FuelLog } from "../storage/fuelLogs";

export interface LoggableRun {
  runId: string;
  day: number;
  movingMin: number;
}

/** Logs count toward what's trained for this many days. */
export const DEMONSTRATED_WINDOW_DAYS = 84;
/** How far back a long run still asks for a log. */
export const LOG_ASK_DAYS = 7;

/** Highest g/h taken with the stomach fine or a bit off (or not said), on
 * a run of FUELLED_RUN_MINUTES or more in the last 12 weeks; null without
 * one. */
export function demonstratedIntake(runs: LoggableRun[], logs: Record<string, FuelLog>, today: number): number | null {
  let best: number | null = null;
  for (const r of runs) {
    const log = logs[r.runId];
    if (!log || log.skipped || log.gPerH === undefined) continue;
    if (r.movingMin < FUELLED_RUN_MINUTES || r.day > today || today - r.day > DEMONSTRATED_WINDOW_DAYS) continue;
    if ((log.gi ?? 0) > 1) continue;
    best = Math.max(best ?? 0, log.gPerH);
  }
  return best;
}

/**
 * Where the ladder starts: the demonstrated intake, or the athlete's own
 * starting value before any log. The step-up only moves on a log (UX spec
 * §2.8): the latest logged run held at bad stomach (2) keeps its own g/h
 * as the ceiling, and "had to stop" (3) steps 10 g/h below it.
 */
export function ladderStart(runs: LoggableRun[], logs: Record<string, FuelLog>, today: number, startGPerH: number): number {
  const shown = demonstratedIntake(runs, logs, today);
  let start = shown ?? startGPerH;
  const latest = runs
    .filter((r) => logs[r.runId]?.gPerH !== undefined && !logs[r.runId].skipped && r.day <= today)
    .sort((a, b) => b.day - a.day)[0];
  const log = latest && logs[latest.runId];
  if (log && log.gPerH !== undefined && (log.gi ?? 0) >= 2) start = Math.min(start, log.gi === 3 ? log.gPerH - 10 : log.gPerH);
  return Math.max(0, start);
}

/** Long runs of the last week with neither a log nor a skip, newest first. */
export function runsNeedingFuelLog<R extends LoggableRun>(runs: R[], logs: Record<string, FuelLog>, today: number): R[] {
  return runs
    .filter((r) => r.movingMin >= FUELLED_RUN_MINUTES && r.day <= today && today - r.day <= LOG_ASK_DAYS && !logs[r.runId])
    .sort((a, b) => b.day - a.day);
}

/** One-tap choices around the session's target: target -20 to +20 in
 * steps of 10 (at least 0), or 30-70 without a target. */
export function fuelPresets(targetGPerH: number | undefined): number[] {
  const centre = targetGPerH ?? 50;
  return [-20, -10, 0, 10, 20].map((d) => Math.round((centre + d) / 5) * 5).filter((g, i, all) => g >= 0 && all.indexOf(g) === i);
}
