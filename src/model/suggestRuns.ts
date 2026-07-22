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
 * and the "unresponsive" flag this app's own fit reports for such runs).
 * Exported so RunLibraryPanel.tsx's runFit() can apply the same bar to
 * already-fetched runs, not just to which summary-only runs are worth
 * fetching in the first place -- see that file's own doc on why. */
export const DURABILITY_MIN_DURATION_S = 60 * 60;
/** Widen the candidate pool before diversifying by descent, so the final
 * picks span a range of descent profiles instead of just whichever happen
 * to be longest -- descent variety is what the tau-vs-descent diagnostic
 * (PLAN.md §12/§13) actually needs, not raw duration alone. */
const DURABILITY_POOL_MULTIPLIER = 3;

/** For the joint (f0, fInf, tau) fit (PLAN.md §11) -- not runnable yet (still
 * needs a level-anchor term), but it needs races spanning a genuinely wide
 * duration range (roughly 2x+) to separate f0 from fInf at all, so it's
 * worth surfacing candidates now rather than only once the fit exists.
 * "Meaningfully shorter" means an actual ratio, not just the next-longest
 * run of similar length. */
const DURATION_SPREAD_MIN_RATIO = 2;
/** Floor for a "shorter" duration-spread candidate -- long enough to be a
 * genuine race effort, not a sprint interval. */
const DURATION_SPREAD_MIN_DURATION_S = 20 * 60;

const DEFAULT_CANDIDATE_COUNT = 10;

export interface RunSuggestions {
  vo2max: StoredRun[];
  durability: StoredRun[];
  /** Candidates for a future joint (f0, fInf, tau) fit -- the single longest
   * available race plus others at least DURATION_SPREAD_MIN_RATIO shorter,
   * so the fit (once buildable) has real duration range to separate the
   * three parameters instead of races clustered at one length. */
  durationSpread: StoredRun[];
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
 * rounding lands on the same index twice. A single requested pick takes the
 * far end of the range (the item most different from whatever else was
 * already picked alongside it), not an arbitrary midpoint. */
function evenlySpacedPicks<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[items.length - 1]];
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    const item = items[Math.round((i * (items.length - 1)) / (count - 1))];
    if (!picks.includes(item)) picks.push(item);
  }
  return picks;
}

/** See RunSuggestions.durationSpread. Picks the single longest available
 * race, then the longest-among-the-qualifying-shorter races (still gives
 * the fit the most signal per race) that are at least
 * DURATION_SPREAD_MIN_RATIO shorter than it. */
function findDurationSpreadCandidates(unfetched: StoredRun[], candidateCount: number): StoredRun[] {
  const byDurationDesc = [...unfetched].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  const longest = byDurationDesc[0];
  if (!longest) return [];
  const longestDuration = longest.durationS ?? 0;
  const shorter = byDurationDesc
    .slice(1)
    .filter((r) => (r.durationS ?? 0) >= DURATION_SPREAD_MIN_DURATION_S)
    .filter((r) => longestDuration / (r.durationS ?? Infinity) >= DURATION_SPREAD_MIN_RATIO)
    .sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  return [longest, ...shorter.slice(0, candidateCount - 1)];
}

export function suggestRunsForFit(runs: StoredRun[], candidateCount = DEFAULT_CANDIDATE_COUNT): RunSuggestions {
  const unfetched = runs.filter((r) => r.points === null && r.durationS !== undefined);

  const vo2max = unfetched
    .filter((r) => (r.durationS ?? 0) >= VO2MAX_MIN_DURATION_S && (r.durationS ?? Infinity) <= VO2MAX_MAX_DURATION_S)
    .sort((a, b) => signalTier(a) - signalTier(b) || intensityValue(b) - intensityValue(a))
    .slice(0, candidateCount);

  const longEnough = unfetched.filter((r) => (r.durationS ?? 0) >= DURABILITY_MIN_DURATION_S);
  const byDurationDesc = [...longEnough].sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  const pool = byDurationDesc.slice(0, candidateCount * DURABILITY_POOL_MULTIPLIER);
  // The single longest run is always kept -- it's usually the most
  // responsive for the tau fit (PLAN.md §12/§13) -- and only the *remaining*
  // slots get diversified by descent, so descent variety never comes at the
  // cost of dropping the most duration-informative run. These same runs,
  // once fetched, are also what feeds stage 5's tau-vs-descent diagnostic --
  // there's no separate bucket for that, since it needs the same "long
  // enough, descent-diverse" candidates this one already targets.
  const durability =
    pool.length === 0
      ? []
      : [pool[0], ...evenlySpacedPicks([...pool.slice(1)].sort((a, b) => descentPerKmProxy(a) - descentPerKmProxy(b)), candidateCount - 1)];

  const durationSpread = findDurationSpreadCandidates(unfetched, candidateCount);

  return { vo2max, durability, durationSpread };
}
