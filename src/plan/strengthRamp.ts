// Where the athlete is on the ramp to heavy lifting (planGenerator.ts
// STRENGTH_RAMP), from the strength they've actually done: each week with
// a strength session moves one level up, each week without one slides
// half a level back, so a break costs some of the build-up but not all of
// it (user idea, 2026-10-23). Assumption: strength fades slowly over a few
// weeks off rather than all at once; the half-level rate is this design's.
import { dayNumberOf } from "./historyFromRuns";

/** Level at which the ramp is done and sessions are heavy. */
export const RAMP_LEVELS = 6;
const FADE_PER_WEEK = 0.5;

const mondayOf = (day: number) => day - ((((day + 3) % 7) + 7) % 7);

/**
 * Ramp level at the start of the week of `today`, counting the full weeks
 * from `startedOn` (a Monday, YYYY-MM-DD) up to it. `doneDates` are days
 * (YYYY-MM-DD) with strength done, ticked by hand or from Strava.
 */
export function strengthRampLevel(startedOn: string | null, doneDates: string[], today: number): number {
  if (!startedOn) return 0;
  const start = mondayOf(dayNumberOf(startedOn));
  const thisWeek = mondayOf(today);
  const doneWeeks = new Set(doneDates.map((d) => mondayOf(dayNumberOf(d))));
  let level = 0;
  for (let w = start; w < thisWeek; w += 7) {
    level = doneWeeks.has(w) ? Math.min(RAMP_LEVELS, level + 1) : Math.max(0, level - FADE_PER_WEEK);
  }
  return level;
}
