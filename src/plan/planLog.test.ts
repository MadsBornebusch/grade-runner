import { describe, expect, it } from "vitest";
import { dateOfDayNumber } from "./historyFromRuns";
import type { PlanSnapshot } from "./planFromSettings";
import { mondayOf, type PlannedSession, type PlanWeek } from "./planGenerator";
import { EMPTY_PLAN_LOG, weeksWithLog, withPastDays } from "./planLog";

const MONDAY = mondayOf(20000);
const run = (day: number, minutes = 40): PlannedSession => ({ day, kind: "easy", minutes, distanceKm: 6, mechanical: 50, descentM: 0, steepDescentM: 0, climbM: 0 });
const week = (start: number, sessions: PlannedSession[]): PlanWeek => ({
  start, phase: "base", chronicAtStart: 40, targetMechanical: 300, plannedMechanical: 300, plannedMinutes: 200, budgetMinutes: 300, budgetBinds: false, longRunWeek: false, sessions, notes: [],
});
const snapshot = (generatedOn: number, weeks: PlanWeek[]): PlanSnapshot => ({
  version: 1, generatedOn, weekOf: mondayOf(generatedOn), inputsKey: "k", generic: false,
  plan: { status: "ok", weeks, projectedChronicAtRace: 0, comparableRaces: [], budgetBindsFrom: null, warnings: [] },
});

describe("plan log", () => {
  // Planned on Monday: Tue, Thu and Sat runs; the next week a Tue run.
  const monday = snapshot(MONDAY, [week(MONDAY, [run(MONDAY + 1), run(MONDAY + 3), run(MONDAY + 5, 120)]), week(MONDAY + 7, [run(MONDAY + 8)])]);

  it("keeps the days before today as planned, rest days too, and the week's header", () => {
    const log = withPastDays(EMPTY_PLAN_LOG, monday, MONDAY + 4);
    expect(Object.keys(log.byDay)).toEqual([0, 1, 2, 3].map((k) => dateOfDayNumber(MONDAY + k)));
    expect(log.byDay[dateOfDayNumber(MONDAY)]).toEqual([]);
    expect(log.byDay[dateOfDayNumber(MONDAY + 3)]).toEqual([run(MONDAY + 3)]);
    expect(log.weeks[dateOfDayNumber(MONDAY)]).toMatchObject({ phase: "base", plannedMinutes: 200 });
    expect(log.weeks[dateOfDayNumber(MONDAY + 7)]).toBeUndefined();
    expect(withPastDays(log, monday, MONDAY + 4)).toBe(log); // nothing new
  });

  it("doesn't let a mid-week plan wipe the days before it", () => {
    const log = withPastDays(EMPTY_PLAN_LOG, monday, MONDAY + 3);
    // Re-planned Wednesday: Thursday moves to Friday.
    const wednesday = snapshot(MONDAY + 2, [week(MONDAY, [run(MONDAY + 4), run(MONDAY + 5, 120)]), week(MONDAY + 7, [run(MONDAY + 8)])]);
    const later = withPastDays(log, wednesday, MONDAY + 7);
    expect(later.byDay[dateOfDayNumber(MONDAY + 1)]).toEqual([run(MONDAY + 1)]);
    expect(later.byDay[dateOfDayNumber(MONDAY + 3)]).toEqual([]);
    expect(later.byDay[dateOfDayNumber(MONDAY + 4)]).toEqual([run(MONDAY + 4)]);

    // The week shown after the Wednesday re-plan: Tuesday from the log.
    expect(weeksWithLog(log, wednesday)[0].sessions.map((s) => s.day)).toEqual([MONDAY + 1, MONDAY + 4, MONDAY + 5]);
  });

  it("shows logged weeks before the plan's, by their logged days", () => {
    const log = withPastDays(EMPTY_PLAN_LOG, monday, MONDAY + 7);
    const next = snapshot(MONDAY + 7, [week(MONDAY + 7, [run(MONDAY + 8)])]);
    const weeks = weeksWithLog(log, next);
    expect(weeks.map((w) => w.start)).toEqual([MONDAY, MONDAY + 7]);
    expect(weeks[0].sessions).toEqual(monday.plan.weeks[0].sessions);
    expect(weeks[1]).toBe(next.plan.weeks[0]);
  });

  it("forgets days more than about a year old", () => {
    const log = withPastDays(EMPTY_PLAN_LOG, monday, MONDAY + 7);
    expect(Object.keys(withPastDays(log, null, MONDAY + 500).byDay)).toEqual(Object.keys(log.byDay)); // null: no change at all
    const pruned = withPastDays(log, snapshot(MONDAY + 500, [week(mondayOf(MONDAY + 500), [])]), MONDAY + 500);
    expect(Object.keys(pruned.byDay).some((k) => k === dateOfDayNumber(MONDAY))).toBe(false);
    expect(pruned.weeks[dateOfDayNumber(MONDAY)]).toBeUndefined();
  });
});
