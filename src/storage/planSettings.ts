// The athlete's plan inputs (PLAN.md §15 stage 4 UI): goal race, weekly
// schedule, per-week long-run moves and strength ticks. Browser-only for
// now, like the run library.
import { createLocalStore } from "./localStore";

export interface GoalRaceSettings {
  /** StoredCourse.id in the course library. */
  courseId: string;
  name: string;
  /** Local date, YYYY-MM-DD. */
  date: string;
  distanceKm: number;
  /** From the course; null when the course has no elevation. */
  descentM: number | null;
  steepDescentM: number | null;
  /** The planner's finish-time prediction for the course, cached so the
   * plan doesn't wait for a long solve on every open. */
  predictedFinishS: number | null;
  /** Race effort from the same prediction (solverInputs.ts's
   * RacePrediction), for the long runs' steady block. */
  raceEffortWPerKg?: number | null;
  /** The athlete's own expected finish, used instead of the prediction. */
  expectedHoursOverride: number | null;
  /** goalRace.ts's predictionKey of the settings the prediction used. */
  predictionKey?: string;
}

export interface ScheduleSettings {
  weeklyMinutes: number;
  runsPerWeek: number;
  /** 0 = Monday ... 6 = Sunday. */
  longRunWeekday: number;
  /** null = follow the suggestion from the race. */
  longRunMaxMinutes: number | null;
  longRunWeekEvery: 1 | 2;
  strengthSessions: number;
  strengthCountsInBudget: boolean;
}

export interface PlanSettings {
  version: 1;
  goalRace: GoalRaceSettings | null;
  schedule: ScheduleSettings;
  /** Per-week long-run moves: Monday (YYYY-MM-DD) -> weekday. */
  longRunMoves: Record<string, number>;
  /** Strength sessions ticked done, by day (YYYY-MM-DD). */
  strengthDone: Record<string, true>;
  /** Carbs per hour the long-run ladder starts from before any log. */
  carbsStartGPerH: number;
  checkinsEnabled: boolean;
}

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  weeklyMinutes: 300,
  runsPerWeek: 4,
  longRunWeekday: 5,
  longRunMaxMinutes: null,
  longRunWeekEvery: 2,
  strengthSessions: 2,
  strengthCountsInBudget: false,
};

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  version: 1,
  goalRace: null,
  schedule: DEFAULT_SCHEDULE,
  longRunMoves: {},
  strengthDone: {},
  carbsStartGPerH: 30,
  checkinsEnabled: true,
};

export const planSettingsStore = createLocalStore<PlanSettings>("grade-runner.plan.v1", DEFAULT_PLAN_SETTINGS, (s) => ({
  ...s,
  schedule: { ...DEFAULT_SCHEDULE, ...s.schedule },
}));

/** The race's expected duration in hours: the override, else the
 * prediction, else null (no plan can be sized yet). */
export function expectedHoursOf(race: GoalRaceSettings): number | null {
  if (race.expectedHoursOverride) return race.expectedHoursOverride;
  return race.predictedFinishS ? race.predictedFinishS / 3600 : null;
}
