// PLAN.md §15 layer 4, "Session guards" and "Guard reference after a race":
// no prescribed session much bigger than the biggest *non-race* run of the
// previous 30 days, checked per run (not per-day sums) on duration,
// distance, descent and steep descent. loadLedger.ts's spikeReferences does
// the day-level version for the load the plan prescribes from; this is the
// per-session one.

export interface GuardRun {
  /** Days since 1970-01-01. */
  day: number;
  movingMin: number;
  distanceKm: number;
  descentM: number;
  steepDescentM: number;
  /** Elevation gain, m. */
  climbM: number;
}

export type GuardQuantity = "movingMin" | "distanceKm" | "descentM" | "steepDescentM" | "climbM";
export const GUARD_QUANTITIES: GuardQuantity[] = ["movingMin", "distanceKm", "descentM", "steepDescentM", "climbM"];

export type RunReference = Record<GuardQuantity, number>;

/** Prescribed sessions stay within this multiple of the reference
 * (Frandsen's reference group: runs at most 10% longer). */
export const SESSION_GUARD_MULTIPLE = 1.1;
/** A run more than this multiple of its reference (on duration or
 * distance) is a race: it doesn't raise later references (Frandsen's
 * "large" bucket, the same 2x as capSpikes). */
export const RACE_MULTIPLE = 2;

/**
 * Allowances any athlete can take regardless of history, so a road runner's
 * first trail run isn't a 30x "spike" against a 10 m reference. Guesses,
 * not fitted (PLAN.md §15 steep-descent notes).
 */
export const GUARD_FLOORS: RunReference = { movingMin: 45, distanceKm: 8, descentM: 300, steepDescentM: 150, climbM: 300 };

const WINDOW_DAYS = 30;
/** After a break, half the biggest run of this longer window still counts,
 * like capSpikes' return window. */
const RETURN_WINDOW_DAYS = 90;

/**
 * Each run's reference, from the earlier non-race runs only: per quantity,
 * the biggest of the previous 30 days or half the biggest of the previous
 * 90, whichever is larger. `isRace[i]` says whether run i was itself a race
 * against its reference. Runs must be in time order.
 */
export function runReferences(runs: GuardRun[]): { reference: RunReference[]; isRace: boolean[] } {
  const reference: RunReference[] = [];
  const isRace: boolean[] = [];
  for (let i = 0; i < runs.length; i++) {
    const ref = referenceAt(runs.slice(0, i).filter((_, j) => !isRace[j]), runs[i].day);
    reference.push(ref);
    const r = runs[i];
    const established = runs[0] !== undefined && r.day - runs[0].day >= WINDOW_DAYS;
    isRace.push(
      established &&
        ((ref.movingMin > 0 && r.movingMin > RACE_MULTIPLE * ref.movingMin) ||
          (ref.distanceKm > 0 && r.distanceKm > RACE_MULTIPLE * ref.distanceKm)),
    );
  }
  return { reference, isRace };
}

/** The reference on `day` from `nonRaceRuns` (all strictly before it). */
export function referenceAt(nonRaceRuns: GuardRun[], day: number): RunReference {
  const out = { movingMin: 0, distanceKm: 0, descentM: 0, steepDescentM: 0, climbM: 0 };
  for (const q of GUARD_QUANTITIES) {
    let recent = 0;
    let longer = 0;
    for (const r of nonRaceRuns) {
      const age = day - r.day;
      if (age <= 0 || age > RETURN_WINDOW_DAYS) continue;
      longer = Math.max(longer, r[q]);
      if (age <= WINDOW_DAYS) recent = Math.max(recent, r[q]);
    }
    out[q] = Math.max(recent, 0.5 * longer);
  }
  return out;
}

/** The most a prescribed session may have of each quantity on a day whose
 * reference is `ref`. */
export function sessionAllowance(ref: RunReference): RunReference {
  const out = { ...ref };
  for (const q of GUARD_QUANTITIES) out[q] = Math.max(GUARD_FLOORS[q], SESSION_GUARD_MULTIPLE * ref[q]);
  return out;
}

/** The quantities on which `run` exceeds its allowance, with the ratio to
 * the reference. */
export function guardBreaches(run: GuardRun, ref: RunReference): { quantity: GuardQuantity; ratio: number }[] {
  const allow = sessionAllowance(ref);
  return GUARD_QUANTITIES.filter((q) => run[q] > allow[q] + 1e-9).map((q) => ({ quantity: q, ratio: ref[q] > 0 ? run[q] / ref[q] : Infinity }));
}
