// Shared wording for progress: the Today line, the Progress page and the
// goal race card say the same thing the same way.
import type { Phase } from "../../plan/planGenerator";
import type { PredictionEntry } from "../../storage/predictionLog";
import { dayNumberOf } from "../../plan/historyFromRuns";
import { shortDate } from "./planCopy";

/** The model's finish: "Predicted" once the pacing margin is fitted from
 * the athlete's races, "Best-case" (a perfect day) before. */
export const modelFinishLabel = (hasPacingMargin: boolean) => (hasPacingMargin ? "Predicted finish" : "Best-case finish");

/** Weeks where less load is the plan, so a drop isn't news. */
const EASY_PHASES: ReadonlySet<Phase> = new Set(["recovery", "deload", "taper", "race"]);

/** Below this the 6-week level counts as steady. */
export const STEADY_CHANGE = 0.02;

export interface LoadTrend {
  text: string;
  /** "up" is shown in the success colour. */
  tone: "up" | "neutral";
}

/**
 * The 6-week load's 4-week change, read against the current week's phase:
 * a rise is shown; a drop in an easy, recovery or taper week is the plan
 * working; a drop in a build week isn't a headline (the plan already took
 * it into account), so it just reads as the level.
 */
export function loadTrend(change: number | null, phase: Phase | undefined): LoadTrend | null {
  if (phase && EASY_PHASES.has(phase) && (change === null || change < STEADY_CHANGE)) {
    return { text: phase === "recovery" ? "Recovering, as planned" : phase === "taper" || phase === "race" ? "Tapering, as planned" : "Easier week, as planned", tone: "neutral" };
  }
  if (change === null) return null;
  if (change >= STEADY_CHANGE) return { text: `↑ ${Math.round(change * 100)}% in 4 weeks`, tone: "up" };
  if (change > -STEADY_CHANGE) return { text: "Steady", tone: "neutral" };
  return null;
}

/** "4 min faster since 28 Oct", from the first logged prediction; null
 * under a minute's change or with one entry. */
export function predictionDelta(entries: PredictionEntry[]): { text: string; faster: boolean } | null {
  if (entries.length < 2) return null;
  const diffS = entries.at(-1)!.finishS - entries[0].finishS;
  const min = Math.round(Math.abs(diffS) / 60);
  if (min < 1) return null;
  const amount = min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${min} min`;
  return { text: `${amount} ${diffS < 0 ? "faster" : "slower"} since ${shortDate(dayNumberOf(entries[0].date))}`, faster: diffS < 0 };
}
