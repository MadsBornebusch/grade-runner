// PLAN.md §11 stage 3: fits a per-athlete HR-to-effort mapping from any
// recorded run with both pace-derived power (see analysis.ts -- always
// derived from GPS pace + gradient via Minetti, never a device's own power
// reading) and heart rate. Unlike the tau/fInf fits in pacingFit.ts, this
// isn't a within-race fatigue shape -- HR-to-effort should be a roughly
// stable athlete-level relationship across races, so pooling every (HR,
// effort) pair from every race into one weighted linear regression is the
// right level of complexity, not a per-race-slope trick.
//
// Cardiac drift (HR climbing at constant true output, from rising core
// temperature/dehydration/reduced stroke volume, not increased metabolic
// intensity -- 10-15bpm typical over a long aerobic effort, worse in heat)
// means late-race HR is a worse proxy for effort than early-race HR. This
// restricts fitting to the early portion of each race, where the confound
// is smallest.

import type { CeilingParams } from "./ceiling";
import { ceilingPower } from "./ceiling";
import { type EffortTrendPoint, MIN_FIT_POINTS } from "./pacingFit";

/** Fraction of each race's own duration considered "early enough" to trust
 * HR as an effort proxy -- PLAN.md's own cardiac-drift research puts
 * meaningful drift onset around 25km into a marathon-length effort, i.e.
 * roughly the back third of a several-hour race. */
const EARLY_WINDOW_FRACTION = 0.65;

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 75;

function daysAgo(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
}

export interface HrEffortCalibration {
  /** effortFraction per bpm. */
  slope: number;
  intercept: number;
  /** Weighted R² -- how well HR actually tracks this athlete's effort. A
   * low value is a legitimate result (HR may just not be a reliable proxy
   * for this athlete), not a bug in the fit. */
  rSquared: number;
  pointCount: number;
  raceCount: number;
}

/** effortFraction implied by the current ceiling at this point -- same
 * quantity every other fit in this codebase computes (grossPower over
 * ceiling), just factored out here since it's needed per-point before the
 * regression below. Returns null if the ceiling is non-positive (can't
 * divide) or heartRateBpm is missing. */
function effortFractionForHrPoint(p: EffortTrendPoint, ceilingParams: CeilingParams): number | null {
  if (p.heartRateBpm === undefined) return null;
  const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
  if (ceiling <= 0) return null;
  return p.grossPowerWPerKg / ceiling;
}

/**
 * Fits `effortFraction ≈ intercept + slope * heartRateBpm` via weighted
 * least squares, pooling qualifying points (has HR, within the early
 * window of its own race) across every race supplied, weighted by segment
 * duration and by race recency (mirroring pacingFit.ts's other multi-race
 * fits). Returns null if fewer than MIN_FIT_POINTS points qualify, or if
 * pooled HR shows no variance to regress against (a flat HR reading can't
 * identify a slope).
 */
export function fitHrToEffortCalibrationAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: { raceDates?: (Date | null)[]; halfLifeDays?: number; now?: Date } = {},
): HrEffortCalibration | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  interface Sample {
    hr: number;
    effortFraction: number;
    weight: number;
  }
  const samples: Sample[] = [];
  const contributingRaceIndices = new Set<number>();

  races.forEach((race, raceIndex) => {
    if (race.length === 0) return;
    const raceDurationHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
    if (!(raceDurationHours > 0)) return;
    const earlyCutoffHours = raceDurationHours * EARLY_WINDOW_FRACTION;
    const date = opts.raceDates?.[raceIndex] ?? null;
    const recencyWeight = date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1;

    for (const p of race) {
      if (p.tHours >= earlyCutoffHours) continue;
      const effortFraction = effortFractionForHrPoint(p, ceilingParams);
      if (effortFraction === null) continue;
      samples.push({ hr: p.heartRateBpm!, effortFraction, weight: p.dtS * recencyWeight });
      contributingRaceIndices.add(raceIndex);
    }
  });

  if (samples.length < MIN_FIT_POINTS) return null;

  const sumW = samples.reduce((s, p) => s + p.weight, 0);
  if (!(sumW > 0)) return null;
  const meanHr = samples.reduce((s, p) => s + p.weight * p.hr, 0) / sumW;
  const meanEffort = samples.reduce((s, p) => s + p.weight * p.effortFraction, 0) / sumW;

  let sXY = 0;
  let sXX = 0;
  let sYY = 0;
  for (const p of samples) {
    const dHr = p.hr - meanHr;
    const dEffort = p.effortFraction - meanEffort;
    sXY += p.weight * dHr * dEffort;
    sXX += p.weight * dHr * dHr;
    sYY += p.weight * dEffort * dEffort;
  }
  if (!(sXX > 0)) return null; // no HR variance to regress against

  const slope = sXY / sXX;
  const intercept = meanEffort - slope * meanHr;
  const rSquared = sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 0;

  return {
    slope,
    intercept,
    rSquared,
    pointCount: samples.length,
    raceCount: contributingRaceIndices.size,
  };
}

/** Predicted effortFraction at a given heart rate under a fitted
 * calibration -- multiply by the current ceiling (ceilingPower) to get a
 * power estimate usable anywhere pace-derived power is (e.g.
 * substrate.ts's splitPower/bonkPowerWPerKg), which is what makes this
 * plug into the existing fat-ox-curve pipeline without any new
 * substrate-layer code. */
export function predictEffortFractionFromHr(heartRateBpm: number, calibration: HrEffortCalibration): number {
  return calibration.intercept + calibration.slope * heartRateBpm;
}
