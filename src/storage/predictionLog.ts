// The goal race's predicted finish over time, for the Progress page. The
// prediction itself (GoalRaceSettings.predictedFinishS) is overwritten on
// every re-solve, so this keeps a copy: one entry per change, per race
// (course and date), so a new goal race starts its own line.
import { createLocalStore } from "./localStore";

export interface PredictionEntry {
  /** Local date, YYYY-MM-DD. */
  date: string;
  finishS: number;
}

export const predictionLogStore = createLocalStore<{ version: 1; byRace: Record<string, PredictionEntry[]> }>("grade-runner.predictionLog.v1", {
  version: 1,
  byRace: {},
});

export const raceLogKey = (race: { courseId: string; date: string }) => `${race.courseId}@${race.date}`;

/** The log with `finishS` recorded on `date`: nothing when it equals the
 * last entry (the line steps, so an unchanged day needs no point), a
 * replacement when the last entry is from the same day. */
export function withPrediction(entries: PredictionEntry[], date: string, finishS: number): PredictionEntry[] {
  const last = entries.at(-1);
  if (last && Math.round(last.finishS) === Math.round(finishS)) return entries;
  if (last && last.date === date) {
    const rest = entries.slice(0, -1);
    // Back to the day before's value: today's change is undone.
    return rest.at(-1) && Math.round(rest.at(-1)!.finishS) === Math.round(finishS) ? rest : [...rest, { date, finishS }];
  }
  return [...entries, { date, finishS }];
}
