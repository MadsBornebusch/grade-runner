import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_SETTINGS, type PlanSettings } from "../storage/planSettings";
import { dayNumberOf, type DatedHistoryRun } from "./historyFromRuns";
import { needsReplan, planFromSettings, planInputsKey, scheduleFromSettings } from "./planFromSettings";
import { mondayOf } from "./planGenerator";

const today = dayNumberOf("2026-10-21"); // a Wednesday
const history: DatedHistoryRun[] = Array.from({ length: 60 }, (_, i) => {
  const day = today - 120 + 2 * i;
  return { day, date: "", runId: String(i), source: "summary", movingMin: i % 7 === 0 ? 120 : 50, distanceKm: 9, descentM: 150, steepDescentM: 20, mechanical: 60 };
});
const settings: PlanSettings = {
  ...DEFAULT_PLAN_SETTINGS,
  goalRace: {
    courseId: "c1", name: "Test race", date: "2027-05-29", distanceKm: 50, descentM: 2000, steepDescentM: 500,
    predictedFinishS: 6.1 * 3600, expectedHoursOverride: null,
  },
};
const carbs = { raceGPerH: 90, startGPerH: 60 };

describe("planFromSettings", () => {
  it("says what's missing before it can plan", () => {
    expect(planFromSettings(history, { ...settings, goalRace: null }, today, carbs)).toEqual({ blocker: "noRace" });
    expect(planFromSettings(history, { ...settings, goalRace: { ...settings.goalRace!, predictedFinishS: null } }, today, carbs)).toEqual({ blocker: "noPrediction" });
    expect(planFromSettings([], settings, today, carbs)).toEqual({ blocker: "noHistory" });
  });

  it("plans the current week from today", () => {
    const out = planFromSettings(history, settings, today, carbs);
    if (!("snapshot" in out)) throw new Error("no plan");
    const first = out.snapshot.plan.weeks[0];
    expect(first.start).toBe(mondayOf(today));
    expect(first.sessions.every((s) => s.day >= today)).toBe(true);
    expect(out.snapshot.generic).toBe(true);
  });

  it("turns long-run moves into the generator's map", () => {
    const sched = scheduleFromSettings({ ...settings, longRunMoves: { "2026-10-26": 6 } }, 6);
    expect(sched.longRunWeekdayByWeek?.get(dayNumberOf("2026-10-26"))).toBe(6);
  });
});

describe("needsReplan", () => {
  const key = planInputsKey(settings, carbs)!;
  const snapshot = { version: 1 as const, generatedOn: today, weekOf: mondayOf(today), inputsKey: key, generic: false, plan: {} as never };

  it("keeps the snapshot through the week, re-plans on Monday or changed inputs", () => {
    expect(needsReplan(snapshot, today + 2, key)).toBe(false);
    expect(needsReplan(snapshot, mondayOf(today) + 7, key)).toBe(true);
    expect(needsReplan(snapshot, today, planInputsKey({ ...settings, longRunMoves: { "2026-10-19": 6 } }, carbs)!)).toBe(true);
    expect(needsReplan(null, today, key)).toBe(true);
  });

  it("waits for Monday on a new prediction, re-plans at once on the athlete's own time", () => {
    const repredicted = { ...settings, goalRace: { ...settings.goalRace!, predictedFinishS: 5 * 3600 } };
    expect(planInputsKey(repredicted, carbs)).toBe(key);
    const own = { ...settings, goalRace: { ...settings.goalRace!, expectedHoursOverride: 7 } };
    expect(needsReplan(snapshot, today, planInputsKey(own, carbs)!)).toBe(true);
  });
});
