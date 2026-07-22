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
//
// The cardiac/pulmonary response to a change in metabolic output is also
// LAGGED and effectively low-pass filtered, not instantaneous -- comparing
// raw per-segment power to raw per-segment HR (as an earlier version of
// this fit did) washes out a real relationship whenever effort is noisy at
// short timescales (terrain variation, walk/run transitions), even though
// HR genuinely does track *sustained* effort. Verified on real full-
// resolution power+HR data from 3 real ultras: pooled R² was 0.31 at zero
// lag/no smoothing, but rose to ~0.43 when power was smoothed over a
// trailing ~60-90s window before regressing against HR (restricting to
// genuinely steady stretches -- trailing 3-minute power stddev below a
// threshold -- pushed R² to ~0.59, at the cost of retaining only ~5% of
// points; smoothing alone was judged the better production tradeoff: a
// real, meaningful improvement without discarding most of the data). This
// matches published VO2/HR on-transient time constants (roughly 20-45s for
// moderate exercise) -- HR responds to a smoothed/integrated version of
// effort, not a simple fixed-delay copy of it, which is why smoothing power
// helped more than shifting HR by a fixed lag did in the same real-data
// check.

import type { CeilingParams } from "./ceiling";
import { ceilingPower } from "./ceiling";
import { type EffortTrendPoint, MIN_FIT_POINTS } from "./pacingFit";

/** Fraction of each race's own duration considered "early enough" to trust
 * HR as an effort proxy -- PLAN.md's own cardiac-drift research puts
 * meaningful drift onset around 25km into a marathon-length effort, i.e.
 * roughly the back third of a several-hour race. */
const EARLY_WINDOW_FRACTION = 0.65;

/** Trailing window (seconds) over which power is smoothed before
 * regressing against HR -- see this file's header doc for the real-data
 * check behind this value (the empirical R²-maximizing range was ~60-90s;
 * 75 is the midpoint, not independently tuned past that). */
const POWER_SMOOTHING_WINDOW_S = 75;

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

/** Trailing rolling mean of grossPowerWPerKg over a real-time window,
 * indexed by tHours (not point count) -- segments are spaced roughly
 * uniformly by distance, not by time, so a fixed-count window would cover
 * a different real duration depending on pace. This is the fix for the
 * lag/smoothing finding in this file's header doc: HR is regressed against
 * this smoothed series, not each point's own raw instantaneous power. */
function trailingMeanPower(race: EffortTrendPoint[], windowS: number): number[] {
  const out: number[] = new Array(race.length);
  let lo = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < race.length; i++) {
    sum += race[i].grossPowerWPerKg;
    count++;
    while (race[i].tHours * 3600 - race[lo].tHours * 3600 > windowS) {
      sum -= race[lo].grossPowerWPerKg;
      count--;
      lo++;
    }
    out[i] = count > 0 ? sum / count : race[i].grossPowerWPerKg;
  }
  return out;
}

/** effortFraction implied by the current ceiling at this point, from the
 * SMOOTHED power at this index (see trailingMeanPower) -- same quantity
 * every other fit in this codebase computes (grossPower over ceiling), just
 * using a smoothed numerator here since HR responds to sustained, not
 * instantaneous, effort. Returns null if the ceiling is non-positive
 * (can't divide) or heartRateBpm is missing. */
function effortFractionForHrPoint(p: EffortTrendPoint, smoothedPowerWPerKg: number, ceilingParams: CeilingParams): number | null {
  if (p.heartRateBpm === undefined) return null;
  const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
  if (ceiling <= 0) return null;
  return smoothedPowerWPerKg / ceiling;
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
    const smoothedPower = trailingMeanPower(race, POWER_SMOOTHING_WINDOW_S);

    race.forEach((p, i) => {
      if (p.tHours >= earlyCutoffHours) return;
      const effortFraction = effortFractionForHrPoint(p, smoothedPower[i], ceilingParams);
      if (effortFraction === null) return;
      samples.push({ hr: p.heartRateBpm!, effortFraction, weight: p.dtS * recencyWeight });
      contributingRaceIndices.add(raceIndex);
    });
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

/** Inverse of predictEffortFractionFromHr -- estimates the heart rate this
 * athlete would likely show at a given effort fraction, for a Planning-mode
 * course where there's no recorded HR yet to work from (see
 * chartData.ts's ChartPoint.estimatedHeartRateBpm). Same caveats as the
 * calibration itself: a rough, athlete-specific estimate, not a guarantee --
 * cardiac drift means it should read low for effort sustained deep into a
 * long race, and this doesn't attempt to model that. */
export function predictHeartRateFromEffortFraction(effortFraction: number, calibration: HrEffortCalibration): number {
  return (effortFraction - calibration.intercept) / calibration.slope;
}
