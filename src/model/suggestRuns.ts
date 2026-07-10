// Ranks summary-only runs by how likely they are to usefully inform a fit,
// using only the cheap Strava-summary fields (no GPS points needed) --
// see PLAN.md §12. Keeping the suggested set small is deliberate: each
// suggestion still costs 2 Strava API calls once approved and fetched, so
// this is meant to replace manually scanning hundreds of rows, not to
// invite fetching all of them.

import type { StoredRun } from "../storage/runLibrary";
import { MAX_ESTIMABLE_DURATION_MIN, MIN_ESTIMABLE_DURATION_MIN } from "./vo2MaxEstimate";

/** Shares its window with vo2MaxEstimate.ts's isEstimableEffort -- these
 * suggestions exist specifically to feed that estimator, so a run outside
 * the window it can actually use isn't a useful suggestion (too short and
 * the model's duration curve can't say anything the LT2 cap doesn't
 * already assume; too long and it's an endurance-paced effort, not a
 * near-maximal one -- see PLAN.md §12). */
const VO2MAX_MIN_DURATION_S = MIN_ESTIMABLE_DURATION_MIN * 60;
const VO2MAX_MAX_DURATION_S = MAX_ESTIMABLE_DURATION_MIN * 60;

/** Below this, a run can't span a meaningful fraction of any realistic
 * ultra-scale tau -- suggesting it for the durability/tau fit would just
 * waste a fetch on a run with ~no say in the result (see PLAN.md §12/§13,
 * and the "unresponsive" flag this app's own fit reports for such runs). */
const DURABILITY_MIN_DURATION_S = 60 * 60;
/** Widen the candidate pool before diversifying by descent, so the final
 * picks span a range of descent profiles instead of just whichever happen
 * to be longest -- descent variety is what the tau-vs-descent diagnostic
 * (PLAN.md §12/§13) actually needs, not raw duration alone. */
const DURABILITY_POOL_MULTIPLIER = 3;

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

/** Descent per km, from Strava's summary elevation gain -- the only
 * elevation signal available before points are fetched. On typical
 * loop/point-to-point trail courses gain and loss are strongly correlated,
 * so it stands in for descent load until full points make the real figure
 * available (see tauDiagnostic.ts). */
function descentPerKmProxy(run: StoredRun): number {
  if (!run.elevationGainM || !run.distanceKm) return 0;
  return run.elevationGainM / run.distanceKm;
}

/** Evenly-spaced picks across a sorted array, so the result spans the full
 * range instead of clustering at one end. Dedupes by reference in case
 * rounding lands on the same index twice. */
function evenlySpacedPicks<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  if (items.length <= count) return items;
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    const item = items[Math.round((i * (items.length - 1)) / (count - 1))];
    if (!picks.includes(item)) picks.push(item);
  }
  return picks;
}

export function suggestRunsForFit(runs: StoredRun[], candidateCount = DEFAULT_CANDIDATE_COUNT): RunSuggestions {
  const unfetched = runs.filter((r) => r.points === null && r.durationS !== undefined);

  const vo2max = unfetched
    .filter((r) => (r.durationS ?? 0) >= VO2MAX_MIN_DURATION_S && (r.durationS ?? Infinity) <= VO2MAX_MAX_DURATION_S)
    .sort((a, b) => signalTier(a) - signalTier(b) || intensityValue(b) - intensityValue(a))
    .slice(0, candidateCount);

  const longEnough = unfetched.filter((r) => (r.durationS ?? 0) >= DURABILITY_MIN_DURATION_S);
  const longestPool = [...longEnough]
    .sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0))
    .slice(0, candidateCount * DURABILITY_POOL_MULTIPLIER);
  const byDescent = [...longestPool].sort((a, b) => descentPerKmProxy(a) - descentPerKmProxy(b));
  const durability = evenlySpacedPicks(byDescent, candidateCount);

  return { vo2max, durability };
}
