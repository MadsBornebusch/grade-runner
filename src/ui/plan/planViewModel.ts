import type { DatedHistoryRun } from "../../plan/historyFromRuns";
import type { Plan, PlannedSession, PlanWeek } from "../../plan/planGenerator";
import { formatMinutes } from "./planCopy";

/** Minutes run so far in the week, and the week's planned total (in the
 * current week: what was run before today plus what's planned from today).
 * A weighted hike counts as running: logged as a run it's in `history`;
 * ticked off by hand or as a Strava hike (`hikeDone`), its planned minutes
 * count, unless a run that day already does. */
export function weekProgress(week: PlanWeek, history: DatedHistoryRun[], today: number, hikeDone?: (s: PlannedSession) => boolean) {
  const runs = history.filter((r) => r.day >= week.start && r.day < week.start + 7 && r.day <= today);
  const hikes = hikeDone ? week.sessions.filter((s) => s.kind === "hike" && s.day <= today && hikeDone(s) && !runs.some((r) => r.day === s.day)) : [];
  const doneMin = runs.reduce((s, r) => s + r.movingMin, 0) + hikes.reduce((s, h) => s + h.minutes, 0);
  const doneBeforeToday = runs.filter((r) => r.day < today).reduce((s, r) => s + r.movingMin, 0);
  const isCurrent = today >= week.start && today < week.start + 7;
  const plannedMin = (isCurrent ? doneBeforeToday : 0) + week.plannedMinutes;
  return { doneMin, plannedMin, isCurrent, runs };
}

export interface PlanWarning {
  text: string;
  action?: "schedule";
}

/** Warning cards from the plan's structured fields (UX spec §4.4), never
 * from the generator's English notes. */
export function planWarnings(plan: Plan, expectedHours: number, generic: boolean, raceLabel: (day: number) => string): PlanWarning[] {
  const out: PlanWarning[] = [];
  const longest = Math.max(0, ...plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind === "long").map((s) => s.minutes)));
  const building = plan.weeks.some((w) => w.phase === "base" || w.phase === "specific" || w.phase === "deload");
  if (!building && plan.weeks.length > 0) {
    out.push({ text: `Only ${plan.weeks.length} week${plan.weeks.length === 1 ? "" : "s"} to go: too little time to build. This plan keeps you fresh for race day.` });
  } else if (longest > 0 && longest < 0.4 * expectedHours * 60) {
    out.push({
      text: `Your longest run tops out at ${formatMinutes(longest)}, under 40% of the race's ${formatMinutes(expectedHours * 60)}. A longer long run, even every other week, would help.`,
      action: "schedule",
    });
  }
  const best = [...plan.comparableRaces].sort((a, b) => b.chronicBefore - a.chronicBefore)[0];
  if (best && plan.projectedChronicAtRace < 0.9 * best.chronicBefore) {
    out.push({ text: `On race day you'll be a bit less trained than before ${raceLabel(best.day)}. More hours, or a later race, would close the gap.`, action: "schedule" });
  }
  if (generic) out.push({ text: "Using typical pace and climb values until 20 of your runs with full data have synced." });
  return out;
}
