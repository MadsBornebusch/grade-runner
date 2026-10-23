// Planned vs done, matched by local date only (UX spec, slice 1): a run on
// the session's day counts, whatever it was.
import type { PlannedSession } from "./planGenerator";


export interface DoneRun {
  day: number;
  movingMin: number;
  distanceKm: number;
}

export type SessionState = "done" | "partial" | "skipped" | "today" | "upcoming";

/** A run under this share of the planned minutes is "shorter than planned". */
export const PARTIAL_SHARE = 0.7;

export interface DayMatch<R extends DoneRun = DoneRun> {
  day: number;
  sessions: PlannedSession[];
  runs: R[];
  /** State of the day's run session (a weighted hike counts: it may be
   * logged as a run); null on a day without one. Strength isn't matched:
   * the run library holds runs only (strengthDone.ts ticks it, and hikes
   * logged as Strava hikes). */
  state: SessionState | null;
  /** Runs on a day with no run session. */
  extra: boolean;
}

export function matchDay<R extends DoneRun>(day: number, sessions: PlannedSession[], runs: R[], today: number): DayMatch<R> {
  const daySessions = sessions.filter((s) => s.day === day);
  const dayRuns = runs.filter((r) => r.day === day);
  const run = daySessions.find((s) => s.kind !== "strength");
  const ranMin = dayRuns.reduce((sum, r) => sum + r.movingMin, 0);
  let state: SessionState | null = null;
  if (run) {
    if (dayRuns.length) state = ranMin < PARTIAL_SHARE * run.minutes ? (day === today ? "today" : "partial") : "done";
    else state = day < today ? "skipped" : day === today ? "today" : "upcoming";
  }
  return { day, sessions: daySessions, runs: dayRuns, state, extra: !run && dayRuns.length > 0 };
}

export function matchWeek<R extends DoneRun>(weekStart: number, sessions: PlannedSession[], runs: R[], today: number): DayMatch<R>[] {
  return Array.from({ length: 7 }, (_, i) => matchDay(weekStart + i, sessions, runs, today));
}
