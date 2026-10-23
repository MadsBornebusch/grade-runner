import { useMemo } from "react";
import { dateOfDayNumber } from "../../plan/historyFromRuns";
import type { PlannedSession } from "../../plan/planGenerator";
import type { PlanSnapshot } from "../../plan/planFromSettings";
import { strengthDoneByDay, type StrengthDone } from "../../plan/strengthDone";
import { planSettingsStore } from "../../storage/planSettings";

export type SessionDone = (s: PlannedSession) => StrengthDone | null;

/** Whether a strength session or weighted hike is done: ticked by hand or
 * matched to a Strava activity (strengthDone.ts). Null for other kinds. */
export function useSessionDone(snapshot: PlanSnapshot | null): SessionDone {
  const { strengthDone, strengthFromStrava, hikeDone, hikeFromStrava } = planSettingsStore.use();
  return useMemo(() => {
    const daysOf = (kind: PlannedSession["kind"]) => snapshot?.plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind === kind).map((s) => s.day)) ?? [];
    const strength = strengthDoneByDay(daysOf("strength"), strengthDone, strengthFromStrava);
    const hike = strengthDoneByDay(daysOf("hike"), hikeDone, hikeFromStrava);
    return (s) => (s.kind === "strength" ? strength : s.kind === "hike" ? hike : {})[dateOfDayNumber(s.day)] ?? null;
  }, [snapshot, strengthDone, strengthFromStrava, hikeDone, hikeFromStrava]);
}

/** Ticks a strength session or hike done by hand, or unticks it. */
export function toggleSessionDone(s: PlannedSession): void {
  const field = s.kind === "hike" ? "hikeDone" : "strengthDone";
  planSettingsStore.set((st) => {
    const key = dateOfDayNumber(s.day);
    const done = { ...st[field] };
    if (done[key]) delete done[key];
    else done[key] = true;
    return { ...st, [field]: done };
  });
}
