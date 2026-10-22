// From the stored plan settings to a generated plan: the glue between the
// browser's state (storage/planSettings.ts, the run history) and the pure
// generator. Pure, so the re-plan rule and the inputs mapping are tested.
import { expectedHoursOf, type PlanSettings } from "../storage/planSettings";
import { dayNumberOf, planOptionsFromHistory, usesGenericPlanOptions, type DatedHistoryRun } from "./historyFromRuns";
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

/** Expected hours rounded to 15 min before they key a re-plan, so a small
 * change to a physiology setting doesn't reshuffle the current week. */
export const roundedExpectedHours = (hours: number) => Math.round(hours * 4) / 4;

export function planInputsKey(settings: PlanSettings, carbs: CarbInputs): string | null {
  const race = settings.goalRace;
  const hours = race && expectedHoursOf(race);
  if (!race || !hours) return null;
  // The leading version bumps when the generator's output changes shape,
  // so stored snapshots regenerate.
  return JSON.stringify([
    2, race.courseId, race.date, race.descentM, race.steepDescentM, roundedExpectedHours(hours),
    settings.schedule, settings.longRunMoves, carbs.raceGPerH, settings.carbsStartGPerH,
  ]);
}

/** Re-plan only on a new week, changed inputs, or no snapshot: a sync
 * during the week keeps the current week as it is. */
export function needsReplan(snapshot: PlanSnapshot | null, today: number, inputsKey: string): boolean {
  return !snapshot || snapshot.weekOf !== mondayOf(today) || snapshot.inputsKey !== inputsKey;
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
      carbs: { raceGPerH: carbs.raceGPerH, startGPerH: carbs.startGPerH },
      includeCurrentWeek: true,
    },
  );
  return { snapshot: { version: 1, generatedOn: today, weekOf: mondayOf(today), inputsKey, generic: usesGenericPlanOptions(past), plan } };
}
