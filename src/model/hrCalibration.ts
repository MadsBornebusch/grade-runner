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
import { ceilingPower, maxAerobicPower, sustainableFraction } from "./ceiling";
import { type EffortTrendPoint, MIN_FIT_POINTS, poolIndicesInformativeAtReference } from "./pacingFit";
import { paceToGrossPowerWPerKg } from "./substrate";

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

/**
 * Minutes excluded from the START of every race, on top of the existing
 * EARLY_WINDOW_FRACTION cutoff at the end -- a distinct, much longer
 * phenomenon from POWER_SMOOTHING_WINDOW_S's ~60-90s VO2-kinetics lag:
 * heart rate takes several minutes to fully settle to a new steady
 * submaximal workload (a genuine physiological onset transient, not
 * something a short trailing-mean window corrects for), and this
 * settling-in period was previously included in every race's fit
 * unfiltered. That barely affects a many-hour race (a negligible fraction
 * of its usable window) but can dominate a short one -- pulling the
 * pooled intercept toward "lower HR for a given effort" and contributing
 * to the same real-data under-prediction bias (4-10+ bpm on long races)
 * poolIndicesInformativeAtReference's own duration gate was built to fix.
 * Confirmed as a genuinely separate, complementary improvement on real
 * held-out data (Ecotrail 80, Soria Moria, leave-one-out): combining this
 * trim with the duration gate beat either alone (see PLAN.md §14). 15-20
 * minutes was the empirical sweet spot in that check; 15 is used here as
 * the more conservative (less data-discarding) of the two.
 */
const START_TRIM_MINUTES = 15;

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
 *
 * Restricted to races at least as long as the incoming reference tau (see
 * `poolIndicesInformativeAtReference`'s own doc), falling back to every
 * race if too few clear that bar, and to points past START_TRIM_MINUTES
 * into each race. A real held-out check on this athlete's own data found
 * the unrestricted pool under-predicted heart rate on genuinely long
 * races by 4-10+ bpm -- NOT because short races correlate worse or sit at
 * lower effort fractions (checked directly: they don't, some short races
 * correlate better within themselves than the long ones, and short races
 * reach effort fractions as high or higher). The real driver looks like
 * every race's own un-trimmed start-of-run transient (HR still settling
 * to a new steady workload) being a much larger fraction of a short
 * race's usable window than a long one's, biasing the pooled intercept
 * toward "lower HR for a given effort." Restricting to long-only training
 * alone cut that error by 20-24%; adding the start trim on top improved
 * it further in both held-out races tested (see PLAN.md §14) -- the two
 * fixes are complementary, not redundant.
 */
export function fitHrToEffortCalibrationAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: { raceDates?: (Date | null)[]; halfLifeDays?: number; now?: Date } = {},
): HrEffortCalibration | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const totalMinPerRace = races.map((race) => (race.length > 0 ? Math.max(...race.map((p) => p.tHours + p.dtS / 3600)) * 60 : 0));
  const longEnoughIndices = new Set(poolIndicesInformativeAtReference(totalMinPerRace, ceilingParams));

  interface Sample {
    hr: number;
    effortFraction: number;
    weight: number;
  }
  const samples: Sample[] = [];
  const contributingRaceIndices = new Set<number>();

  races.forEach((race, raceIndex) => {
    if (race.length === 0) return;
    if (!longEnoughIndices.has(raceIndex)) return;
    const raceDurationHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
    if (!(raceDurationHours > 0)) return;
    const earlyCutoffHours = raceDurationHours * EARLY_WINDOW_FRACTION;
    const startCutoffHours = START_TRIM_MINUTES / 60;
    const date = opts.raceDates?.[raceIndex] ?? null;
    const recencyWeight = date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1;
    const smoothedPower = trailingMeanPower(race, POWER_SMOOTHING_WINDOW_S);

    race.forEach((p, i) => {
      if (p.tHours < startCutoffHours) return;
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

/** Structural subset of formInputs.ts's FatOxPoint this module actually
 * needs -- avoids importing a ui/ type into model/ (this file stays a leaf
 * the UI depends on, not the other way around); any object shaped like this
 * (including a real FatOxPoint) satisfies it. */
export interface ThresholdFatOxPoint {
  paceMinPerKm: number;
  heartRateBpm?: number;
}

export interface ThresholdCalibrationInputs {
  lt1Fraction: number;
  lt2Fraction: number;
  lt1HeartRateBpm: number | null;
  lt2HeartRateBpm: number | null;
  fatOxPoints: ThresholdFatOxPoint[];
  walkMaxMs: number;
}

/**
 * Fits the same effortFraction ≈ intercept + slope·heartRateBpm shape as
 * fitHrToEffortCalibrationAcrossRaces, but from the athlete's own
 * LAB-MEASURED thresholds/fat-ox test instead of pooled training-run data.
 *
 * LT1/LT2 fractions are already expressed in the exact %VO2max units
 * sustainableFraction() operates in, so converting them to effortFraction
 * needs no Minetti pace conversion, no altitude adjustment, no terrain/GPS
 * noise at all -- none of the machinery the rest of this investigation
 * needed to fight through (warm-up transients, walk breaks, race-duration
 * decay confounds): effortFraction = labFraction / sustainableFraction(0,
 * ceilingParams). LT2's own effortFraction comes out to exactly 1.0
 * whenever the athlete's entered lt2Fraction matches ceilingParams'
 * (the normal case), since LT2 *is* the ceiling's own fresh/undecayed cap
 * by construction -- not a coincidence, a direct consequence of how LT2 is
 * defined elsewhere in this app.
 *
 * Fat-ox points need one extra step, since they're recorded in pace/
 * oxidation-rate terms rather than a %VO2max fraction directly: pace ->
 * gross power via the same Minetti conversion the rest of this app uses
 * (paceToGrossPowerWPerKg), then power -> %VO2max via maxAerobicPower. This
 * reintroduces the Minetti-model uncertainty LT1/LT2 avoid, but it's still
 * a controlled lab measurement, not real-world GPS/terrain data.
 *
 * Every qualifying point (only where heartRateBpm is actually present)
 * counts equally -- unlike the race-pooled fit, there's no natural duration
 * weight for a handful of controlled measurements. Returns null with fewer
 * than 2 usable points (can't fit a line's slope from one), same "no data"
 * convention as every other fit in this file. With exactly 2 points, the
 * fitted line passes through both exactly (rSquared will read 1 by
 * construction) -- that's a property of having only 2 points, not evidence
 * of a confident fit; callers should treat rSquared as meaningful only once
 * pointCount is 3 or more (e.g. a fat-ox curve contributing extra points
 * alongside LT1/LT2).
 */
export function fitHrToEffortCalibrationFromThresholds(
  inputs: ThresholdCalibrationInputs,
  ceilingParams: CeilingParams,
): HrEffortCalibration | null {
  const referenceCeilingFraction = sustainableFraction(0, ceilingParams);
  if (!(referenceCeilingFraction > 0)) return null;

  const points: { hr: number; effortFraction: number }[] = [];
  if (inputs.lt1HeartRateBpm !== null) {
    points.push({ hr: inputs.lt1HeartRateBpm, effortFraction: inputs.lt1Fraction / referenceCeilingFraction });
  }
  if (inputs.lt2HeartRateBpm !== null) {
    points.push({ hr: inputs.lt2HeartRateBpm, effortFraction: inputs.lt2Fraction / referenceCeilingFraction });
  }
  const maxAerobic = maxAerobicPower(0, ceilingParams);
  if (maxAerobic > 0) {
    for (const p of inputs.fatOxPoints) {
      if (p.heartRateBpm === undefined) continue;
      const grossPowerWPerKg = paceToGrossPowerWPerKg(p.paceMinPerKm, inputs.walkMaxMs);
      const intensityFraction = grossPowerWPerKg / maxAerobic;
      points.push({ hr: p.heartRateBpm, effortFraction: intensityFraction / referenceCeilingFraction });
    }
  }

  if (points.length < 2) return null;

  const n = points.length;
  const meanHr = points.reduce((s, p) => s + p.hr, 0) / n;
  const meanEffort = points.reduce((s, p) => s + p.effortFraction, 0) / n;
  let sXY = 0;
  let sXX = 0;
  let sYY = 0;
  for (const p of points) {
    const dHr = p.hr - meanHr;
    const dEffort = p.effortFraction - meanEffort;
    sXY += dHr * dEffort;
    sXX += dHr * dHr;
    sYY += dEffort * dEffort;
  }
  if (!(sXX > 0)) return null;

  const slope = sXY / sXX;
  const intercept = meanEffort - slope * meanHr;
  const rSquared = sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 1;

  return { slope, intercept, rSquared, pointCount: points.length, raceCount: points.length };
}
