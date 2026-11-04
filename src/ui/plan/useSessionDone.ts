import { useMemo } from "react";
import { dateOfDayNumber } from "../../plan/historyFromRuns";
import type { SessionState } from "../../plan/matchSessions";
import type { PlannedSession, PlanWeek } from "../../plan/planGenerator";
import { strengthDoneByDay, tickDate, type StrengthDone } from "../../plan/strengthDone";
import { planSettingsStore } from "../../storage/planSettings";

export type SessionDone = (s: PlannedSession) => StrengthDone | null;

/** A strength session or hike shown on the day it was done, not the day
 * it was planned (`plannedDay`). */
export type ShownSession = PlannedSession & { plannedDay?: number };

/** Whether a strength session or weighted hike is done: ticked by hand or
 * matched to a Strava activity (strengthDone.ts); null for other kinds.
 * And `weeks` with each done one moved to the day it was done. */
export function useSessionDone(weeks: PlanWeek[] | undefined): { weeks: PlanWeek[] | undefined; doneOf: SessionDone } {
  const { strengthDone, strengthFromStrava, hikeDone, hikeFromStrava } = planSettingsStore.use();
  return useMemo(() => {
    const daysOf = (kind: PlannedSession["kind"]) => weeks?.flatMap((w) => w.sessions.filter((s) => s.kind === kind).map((s) => s.day)) ?? [];
    const strength = strengthDoneByDay(daysOf("strength"), strengthDone, strengthFromStrava);
    const hike = strengthDoneByDay(daysOf("hike"), hikeDone, hikeFromStrava);
    const doneOf: SessionDone = (s) =>
      (s.kind === "strength" ? strength : s.kind === "hike" ? hike : {})[dateOfDayNumber((s as ShownSession).plannedDay ?? s.day)] ?? null;
    const moved = weeks?.map((w) => {
      if (!w.sessions.some((s) => { const on = doneOf(s)?.on; return on !== undefined && on !== s.day; })) return w;
      const sessions = w.sessions
        .map((s): ShownSession => { const on = doneOf(s)?.on; return on === undefined || on === s.day ? s : { ...s, day: on, plannedDay: s.day }; })
        .sort((a, b) => a.day - b.day);
      return { ...w, sessions };
    });
    return { weeks: moved, doneOf };
  }, [weeks, strengthDone, strengthFromStrava, hikeDone, hikeFromStrava]);
}

/** Ticks a strength session or hike done by hand (on `today` if that's in
 * its week: tickDate), or unticks it. */
export function toggleSessionDone(s: PlannedSession, done: StrengthDone | null, today: number): void {
  const field = s.kind === "hike" ? "hikeDone" : "strengthDone";
  planSettingsStore.set((st) => {
    const ticks = { ...st[field] };
    if (done?.source === "manual") delete ticks[dateOfDayNumber(done.on)];
    else ticks[tickDate((s as ShownSession).plannedDay ?? s.day, today)] = true;
    return { ...st, [field]: ticks };
  });
}

/** A session's state on the plan: strength by its tick, a hike by its tick
 * (by hand or a Strava hike) or else like a run, other runs by the runs
 * that day (`dayState`, matchSessions.ts). */
export function sessionState(s: PlannedSession, dayState: SessionState | null, doneOf: SessionDone): SessionState | null {
  if (s.kind === "strength") return doneOf(s) ? "done" : null;
  if (s.kind === "hike" && doneOf(s)) return "done";
  return dayState;
}
