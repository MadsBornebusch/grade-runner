// Which of the plan's strength sessions are done: ticked by hand, or
// matched to a strength activity logged on Strava. A Strava session counts
// for the planned one on the same day, else for the nearest still-open one
// in the same week (Monday to Sunday), since the day often shifts.
import { dateOfDayNumber, dayNumberOf } from "./historyFromRuns";

export type StrengthDone = { source: "manual" } | { source: "strava"; name: string };

const mondayOf = (day: number) => day - ((day + 3) % 7);

export function strengthDoneByDay(
  plannedDays: number[],
  manual: Record<string, true>,
  fromStrava: Record<string, string>,
): Record<string, StrengthDone> {
  const done: Record<string, StrengthDone> = {};
  const planned = new Set(plannedDays);
  for (const day of plannedDays) if (manual[dateOfDayNumber(day)]) done[dateOfDayNumber(day)] = { source: "manual" };

  const stravaDays = Object.keys(fromStrava)
    .map((date) => ({ day: dayNumberOf(date), name: fromStrava[date] }))
    .sort((a, b) => a.day - b.day);
  // Same-day matches first, so a shifted session can't take a slot an
  // on-the-day one needs.
  const unmatched = stravaDays.filter(({ day, name }) => {
    if (!planned.has(day)) return true;
    const key = dateOfDayNumber(day);
    if (!done[key]) done[key] = { source: "strava", name };
    return false;
  });
  for (const { day, name } of unmatched) {
    const open = plannedDays
      .filter((d) => mondayOf(d) === mondayOf(day) && !done[dateOfDayNumber(d)])
      .sort((a, b) => Math.abs(a - day) - Math.abs(b - day));
    if (open.length > 0) done[dateOfDayNumber(open[0])] = { source: "strava", name };
  }
  return done;
}
