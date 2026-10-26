// From the stored plan settings to a generated plan: the glue between the
// browser's state (storage/planSettings.ts, the run history) and the pure
// generator. Pure, so the re-plan rule and the inputs mapping are tested.
import { expectedHoursOf, type PlanSettings } from "../storage/planSettings";
import { dayNumberOf, planOptionsFromHistory, usesGenericPlanOptions, type DatedHistoryRun } from "./historyFromRuns";
import { strengthRampLevel } from "./strengthRamp";
import { generatePlan, mondayOf, suggestLongRunMaxMinutes, type Plan, type WeeklySchedule } from "./planGenerator";

export interface PlanSnapshot {
  version: 1;
  /** Day number the plan was generated on, and that day's Monday. */
  generatedOn: number;
  weekOf: number;
  inputsKey: string;
  generic: boolean;
  plan: Plan;
}

export type PlanBlocker = "noRace" | "noPrediction" | "noHistory";

export interface CarbInputs {
  /** Race-day carbs, g/h (the planner's fuelling setting). */
  raceGPerH: number;
  /** Where the long-run ladder starts (carbLadder.ladderStart). */
  startGPerH: number;
}

/** Expected hours rounded to 15 min before they size a plan, so a small
 * change to a physiology setting doesn't reshuffle the weeks. */
export const roundedExpectedHours = (hours: number) => Math.round(hours * 4) / 4;

/**
 * What the athlete set: a change re-plans at once. The predicted finish is
 * left out on purpose: it moves whenever the model learns from a new run
 * (modelRefresh.ts refits after each sync), and that must not reshuffle
 * the current week. A new prediction is picked up on Monday's re-plan, or
 * with "Re-plan now". The athlete's own expected time is in.
 */
export function planInputsKey(settings: PlanSettings, carbs: CarbInputs): string | null {
  const race = settings.goalRace;
  const hours = race && expectedHoursOf(race);
  if (!race || !hours) return null;
  // The leading version bumps when the generator's output changes shape,
  // so stored snapshots regenerate.
  return JSON.stringify([
    7, race.courseId, race.date, race.descentM, race.steepDescentM, race.expectedHoursOverride && roundedExpectedHours(race.expectedHoursOverride),
    settings.schedule, settings.longRunMoves, carbs.raceGPerH, settings.carbsStartGPerH, settings.strengthStartedOn, settings.pastGoalRaces,
  ]);
}

/** Re-plan only on a new week, changed inputs, no snapshot, or the goal
 * race just run (its days off start at once): a sync during the week
 * otherwise keeps the current week as it is. */
export function needsReplan(snapshot: PlanSnapshot | null, today: number, inputsKey: string): boolean {
  return (
    !snapshot ||
    snapshot.weekOf !== mondayOf(today) ||
    snapshot.inputsKey !== inputsKey ||
    (snapshot.plan.status === "ok" && snapshot.plan.weeks.some((w) => w.sessions.some((s) => s.kind === "race" && s.day < today)))
  );
}

export function scheduleFromSettings(settings: PlanSettings, expectedHours: number): WeeklySchedule {
  const s = settings.schedule;
  return {
    weeklyMinutes: s.weeklyMinutes,
    runsPerWeek: s.runsPerWeek,
    longRunWeekday: s.longRunWeekday,
    longRunMaxMinutes: Math.min(s.weeklyMinutes, s.longRunMaxMinutes ?? suggestLongRunMaxMinutes(expectedHours, s.weeklyMinutes)),
    longRunWeekEvery: s.longRunWeekEvery,
    longRunWeekdayByWeek: new Map(Object.entries(settings.longRunMoves).map(([monday, weekday]) => [dayNumberOf(monday), weekday])),
  };
}

export function planFromSettings(
  history: DatedHistoryRun[],
  settings: PlanSettings,
  today: number,
  carbs: CarbInputs,
  /** Runs the athlete confirmed as races (StoredRun.raceTag). */
  raceRunIds: ReadonlySet<string> = new Set(),
): { snapshot: PlanSnapshot } | { blocker: PlanBlocker } {
  const race = settings.goalRace;
  if (!race) return { blocker: "noRace" };
  const hours = expectedHoursOf(race);
  if (!hours) return { blocker: "noPrediction" };
  if (history.length === 0) return { blocker: "noHistory" };
  const inputsKey = planInputsKey(settings, carbs)!;
  // The generator itself only reads runs before today.
  const past = history.filter((r) => r.day < today);
  const plan = generatePlan(
    past,
    scheduleFromSettings(settings, roundedExpectedHours(hours)),
    {
      name: race.name,
      day: dayNumberOf(race.date),
      expectedHours: roundedExpectedHours(hours),
      descentM: race.descentM ?? undefined,
      steepDescentM: race.steepDescentM ?? undefined,
    },
    today,
    {
      ...planOptionsFromHistory(past),
      strengthSessions: settings.schedule.strengthSessions,
      strengthCountsInBudget: settings.schedule.strengthCountsInBudget,
      strengthLevel: strengthRampLevel(settings.strengthStartedOn, [...Object.keys(settings.strengthDone), ...Object.keys(settings.strengthFromStrava)], today),
      carbs: { raceGPerH: carbs.raceGPerH, startGPerH: carbs.startGPerH },
      includeCurrentWeek: true,
      raceDays: [
        dayNumberOf(race.date),
        ...settings.pastGoalRaces.map(dayNumberOf),
        ...history.filter((r) => raceRunIds.has(r.runId)).map((r) => r.day),
      ],
    },
  );
  return { snapshot: { version: 1, generatedOn: today, weekOf: mondayOf(today), inputsKey, generic: usesGenericPlanOptions(past), plan } };
}
