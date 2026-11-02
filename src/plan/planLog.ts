// What was planned for days already gone. The plan only holds the current
// week and the ones ahead, and a re-plan (each Monday, a changed setting,
// an update) drops the days before it, so their sessions are kept here
// before a plan is replaced: the schedule can then show past weeks, and
// the days of this week before a mid-week re-plan, as they were planned.
import { dateOfDayNumber, dayNumberOf } from "./historyFromRuns";
import type { PlanSnapshot } from "./planFromSettings";
import type { PlannedSession, PlanWeek } from "./planGenerator";

export interface PlanLog {
  version: 1;
  /** Local date -> that day's planned sessions (empty: a planned rest day). */
  byDay: Record<string, PlannedSession[]>;
  /** Monday's local date -> the week as last planned, without sessions. */
  weeks: Record<string, Omit<PlanWeek, "sessions">>;
}

export const EMPTY_PLAN_LOG: PlanLog = { version: 1, byDay: {}, weeks: {} };

/** Assumption: a year and a bit of past plans is plenty to look back on,
 * and keeps the log small in localStorage. */
const KEEP_DAYS = 400;

/**
 * The log with `snapshot`'s days before `today` added: each day it planned
 * (from the day it was made) overwrites what an earlier plan said, so the
 * last plan for a day wins; days before it was made keep their entries.
 * Returns `log` itself when nothing changes.
 */
export function withPastDays(log: PlanLog, snapshot: PlanSnapshot | null, today: number): PlanLog {
  if (!snapshot || snapshot.plan.weeks.length === 0) return log;
  const from = Math.max(snapshot.generatedOn, snapshot.weekOf);
  const byDay = { ...log.byDay };
  const weeks = { ...log.weeks };
  let changed = false;
  for (const week of snapshot.plan.weeks) {
    if (week.start >= today) break;
    const { sessions, ...meta } = week;
    const monday = dateOfDayNumber(week.start);
    if (JSON.stringify(weeks[monday]) !== JSON.stringify(meta)) {
      weeks[monday] = meta;
      changed = true;
    }
    for (let day = Math.max(week.start, from); day < Math.min(week.start + 7, today); day++) {
      const planned = sessions.filter((s) => s.day === day);
      const key = dateOfDayNumber(day);
      if (JSON.stringify(byDay[key]) === JSON.stringify(planned)) continue;
      byDay[key] = planned;
      changed = true;
    }
  }
  const oldest = today - KEEP_DAYS;
  for (const store of [byDay, weeks] as Record<string, unknown>[]) {
    for (const key of Object.keys(store)) {
      if (dayNumberOf(key) >= oldest) continue;
      delete store[key];
      changed = true;
    }
  }
  return changed ? { version: 1, byDay, weeks } : log;
}

/**
 * The weeks to show: logged weeks before the plan's first, then the plan's
 * weeks, the days of its first week before it was made filled in from the
 * log. A logged week shows the days the log has.
 */
export function weeksWithLog(log: PlanLog, snapshot: PlanSnapshot): PlanWeek[] {
  const weeks = snapshot.plan.weeks;
  const first = weeks[0]?.start ?? snapshot.weekOf;
  const madeOn = Math.max(snapshot.generatedOn, snapshot.weekOf);
  // A day the log has, else what `fallback` planned for it.
  const loggedDays = (start: number, until: number, fallback: PlannedSession[] = []) => {
    const out: PlannedSession[] = [];
    for (let day = start; day < until; day++) out.push(...(log.byDay[dateOfDayNumber(day)] ?? fallback.filter((s) => s.day === day)));
    return out;
  };
  const past = Object.entries(log.weeks)
    .map(([monday, meta]) => ({ ...meta, start: dayNumberOf(monday) }))
    .filter((w) => w.start < first)
    .sort((a, b) => a.start - b.start)
    .map((meta) => ({ ...meta, sessions: loggedDays(meta.start, meta.start + 7) }));
  const planned = weeks.map((w) =>
    w.start < madeOn ? { ...w, sessions: [...loggedDays(w.start, madeOn, w.sessions), ...w.sessions.filter((s) => s.day >= madeOn)] } : w,
  );
  return [...past, ...planned];
}
