// Which of the plan's strength sessions are done: ticked by hand, or
// matched to a strength activity logged on Strava. Either counts for the
// planned one on the same day, else for the nearest still-open one in the
// same week (Monday to Sunday), since the day often shifts; `on` is the
// day it was done, where the schedule then shows it.
import { dateOfDayNumber, dayNumberOf } from "./historyFromRuns";

export type StrengthDone = ({ source: "manual" } | { source: "strava"; name: string }) & { on: number };

const mondayOf = (day: number) => day - ((day + 3) % 7);

export function strengthDoneByDay(
  plannedDays: number[],
  manual: Record<string, true>,
  fromStrava: Record<string, string>,
): Record<string, StrengthDone> {
  const done: Record<string, StrengthDone> = {};
  const planned = new Set(plannedDays);
  const logged = [
    ...Object.keys(manual).map((date) => ({ day: dayNumberOf(date), done: { source: "manual" as const, on: dayNumberOf(date) } })),
    ...Object.keys(fromStrava).map((date) => ({ day: dayNumberOf(date), done: { source: "strava" as const, name: fromStrava[date], on: dayNumberOf(date) } })),
  ].sort((a, b) => a.day - b.day);
  // Same-day matches first (a hand tick before Strava), so a shifted
  // session can't take a slot an on-the-day one needs.
  const unmatched = logged.filter(({ day, done: d }) => {
    if (!planned.has(day)) return true;
    const key = dateOfDayNumber(day);
    if (!done[key] || (done[key].source === "strava" && d.source === "manual")) done[key] = d;
    return false;
  });
  for (const { day, done: d } of unmatched) {
    const open = plannedDays
      .filter((p) => mondayOf(p) === mondayOf(day) && !done[dateOfDayNumber(p)])
      .sort((a, b) => Math.abs(a - day) - Math.abs(b - day));
    if (open.length > 0) done[dateOfDayNumber(open[0])] = d;
  }
  return done;
}

/** The date a hand tick goes under: the day it's ticked, if that's in
 * the same week (done late or early: it moves there), else the planned
 * day (a past week's, ticked afterwards). */
export function tickDate(plannedDay: number, today: number): string {
  return dateOfDayNumber(mondayOf(plannedDay) === mondayOf(today) ? today : plannedDay);
}
