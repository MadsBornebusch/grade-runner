// Ranks summary-only runs by how likely they are to usefully inform a fit,
// using only the cheap Strava-summary fields (no GPS points needed) --
// see PLAN.md §12. Keeping the suggested set small is deliberate: each
// suggestion still costs 2 Strava API calls once approved and fetched, so
// this is meant to replace manually scanning hundreds of rows, not to
// invite fetching all of them.

import type { StoredRun } from "../storage/runLibrary";

/** Short-to-moderate, per the critical-power/VO2max literature (calibrated
 * on ~2-15min trials) -- a multi-hour race doesn't constrain VO2max well,
 * see PLAN.md §12 Q1. */
const VO2MAX_MAX_DURATION_S = 120 * 60;
const DEFAULT_CANDIDATE_COUNT = 4;

export interface RunSuggestions {
  vo2max: StoredRun[];
  durability: StoredRun[];
}

function avgSpeedKmh(run: StoredRun): number {
  if (!run.distanceKm || !run.durationS) return 0;
  return run.distanceKm / (run.durationS / 3600);
}

/** Power is the most direct intensity proxy, heart rate next, pace as a
 * last resort when neither is recorded -- runs are compared within the same
 * tier only, never across tiers by raw magnitude (a watts number and a bpm
 * number aren't on a comparable scale). */
function signalTier(run: StoredRun): number {
  if (run.avgWatts) return 0;
  if (run.avgHeartRate) return 1;
  return 2;
}

function intensityValue(run: StoredRun): number {
  if (run.avgWatts) return run.avgWatts;
  if (run.avgHeartRate) return run.avgHeartRate;
  return avgSpeedKmh(run);
}

export function suggestRunsForFit(runs: StoredRun[], candidateCount = DEFAULT_CANDIDATE_COUNT): RunSuggestions {
  const unfetched = runs.filter((r) => r.points === null && r.durationS !== undefined);

  const vo2max = unfetched
    .filter((r) => (r.durationS ?? Infinity) <= VO2MAX_MAX_DURATION_S)
    .sort((a, b) => signalTier(a) - signalTier(b) || intensityValue(b) - intensityValue(a))
    .slice(0, candidateCount);

  const durability = [...unfetched].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0)).slice(0, candidateCount);

  return { vo2max, durability };
}
