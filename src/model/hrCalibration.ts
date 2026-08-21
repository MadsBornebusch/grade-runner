// PLAN.md §11 stage 3 (superseded by the 2026-08-21 rework, see PLAN.md):
// fits a per-athlete HR-to-power mapping from any recorded run with both
// pace-derived power (see analysis.ts -- always derived from GPS pace +
// gradient via Minetti, never a device's own power reading) and heart rate.
// Unlike the tau/fInf fits in pacingFit.ts, this isn't a within-race
// fatigue shape -- HR-to-power should be a roughly stable athlete-level
// relationship across races, so pooling every (HR, power) pair from every
// race into one weighted linear regression is the right level of
// complexity, not a per-race-slope trick.
//
// Fits HR directly against raw (terrain-adjusted, NOT ceiling-normalized)
// gross power, not effortFraction (power/ceiling) as an earlier version of
// this file did. Checked directly on this athlete's real cached race data
// (leave-one-out, same weighting/gating either way): raw power explains far
// more of HR's variance than effortFraction does (weighted R² 0.49 vs
// 0.077, apples-to-apples). Two reasons, both real: (1) effortFraction
// divides by a ceiling that decays on a fitted tau/fInf curve which doesn't
// perfectly track this athlete's true within-race fatigue, injecting
// elapsed-time variance HR doesn't actually share; (2) effortFraction is
// bounded near 1.0 by construction (power can't much exceed its own
// ceiling), so points pile up near the top regardless of what HR is doing
// there, losing resolution exactly where LT2-effort predictions need it
// most. Physiologically this also matches the more direct causal chain:
// heart rate tracks something close to absolute metabolic demand (~oxygen
// consumption, which terrain-adjusted power already approximates), not a
// ratio against a modeled, decaying capacity.
//
// Cardiac drift (HR climbing at constant true output, from rising core
// temperature/dehydration/reduced stroke volume, not increased metabolic
// intensity -- 10-15bpm typical over a long aerobic effort, worse in heat)
// means late-race HR is a worse proxy for power than early-race HR. This
// restricts fitting to the early portion of each race, where the confound
// is smallest. An explicit elapsed-time drift term was tried and rejected:
// its fitted coefficient came out NEGATIVE (opposite sign from real
// cardiovascular drift), meaning it was picking up a confound with the
// pacing-decay curve rather than genuine drift signal, and even with it
// added the fit still underperformed the plain two-parameter version below.
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
import { maxAerobicPower } from "./ceiling";
import { type EffortTrendPoint, MIN_FIT_POINTS, poolIndicesInformativeAtReference } from "./pacingFit";
import { paceToGrossPowerWPerKg } from "./substrate";

/** Fraction of each race's own duration considered "early enough" to trust
 * HR as a power proxy -- PLAN.md's own cardiac-drift research puts
 * meaningful drift onset around 25km into a marathon-length effort, i.e.
 * roughly the back third of a several-hour race. Exported for reuse by
 * pacingMarginFit.ts, which needs the SAME restriction for the same reason
 * (a chosen-effort estimate built from drift-elevated late-race HR would
 * read as artificially high effort, not a genuine margin measurement). */
export const EARLY_WINDOW_FRACTION = 0.65;

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
 * pooled intercept toward "lower HR for a given power" and contributing to
 * the same real-data under-prediction bias (4-10+ bpm on long races)
 * poolIndicesInformativeAtReference's own duration gate was built to fix.
 * Confirmed as a genuinely separate, complementary improvement on real
 * held-out data (Ecotrail 80, Soria Moria, leave-one-out): combining this
 * trim with the duration gate beat either alone (see PLAN.md §14). 15-20
 * minutes was the empirical sweet spot in that check; 15 is used here as
 * the more conservative (less data-discarding) of the two.
 */
const START_TRIM_MINUTES = 15;

/**
 * A handful of segments per race have a near-duplicate consecutive GPS
 * timestamp (dtS of a fraction of a second) while still recording a real,
 * nonzero distance between them -- a device/export artifact, not the
 * athlete pausing (checked directly: <2% of the affected points are even
 * near a real pause). Dividing a real distance by a near-zero time produces
 * a nonsensical instantaneous speed, and therefore power, in the hundreds
 * or thousands of W/kg (worst observed case: 0.05s and 25m apart -> 490m/s
 * -> 568 W/kg). Excluded entirely (not clamped) before smoothing, since a
 * single such point can dominate a 75s trailing-mean window that otherwise
 * has few real points in it.
 */
const MIN_SEGMENT_DT_S = 1.0;

/**
 * No realistic sustained gross power exceeds this for this app's athletes
 * (the highest genuine value seen across this athlete's whole cached race
 * history, near-max effort, was under 17 W/kg) -- a second, direct filter
 * on the same GPS-artifact class MIN_SEGMENT_DT_S catches (the median
 * offending segment was ~1.8s, not near-zero, so duration alone doesn't
 * fully separate real data from artifacts; this catches the rest).
 * Excluded entirely, same reasoning as MIN_SEGMENT_DT_S above.
 */
const MAX_PLAUSIBLE_POWER_W_PER_KG = 20;

/**
 * How far back (seconds) to look for each point's own recent peak smoothed
 * power/HR when detecting recovery-lag -- see DECAY_THRESHOLD's doc.
 */
const RECOVERY_LOOKBACK_S = 180;

/**
 * A point is flagged as "recovery lag" (heart rate still elevated from a
 * harder effort a moment ago -- descending after a climb, easing after a
 * surge -- not a real reading of CURRENT power) when its smoothed power has
 * dropped below this fraction of its own recent (RECOVERY_LOOKBACK_S) peak
 * WHILE heart rate is still at or above HR_PROXIMITY_THRESHOLD of ITS OWN
 * recent peak. Both conditions are required: power-decay alone would also
 * flag genuine settled-easy-running (power AND HR both fell together, which
 * is real informative low-power data, not lag) -- checked directly on real
 * data, dropping the HR condition produced a dramatically different, wrong
 * result. Confirmed front-loaded early in each race's fitting window and
 * skewed toward descents (mean gradient -0.22% vs +1.22% for normal
 * points), matching the physiological signature of "power fell, pulse
 * hasn't caught up yet."
 */
const RECOVERY_DECAY_THRESHOLD = 0.75;
const RECOVERY_HR_PROXIMITY_THRESHOLD = 0.95;

/** Flagged points are down-weighted to this fraction, not excluded --
 * they're still real data, just less trustworthy as a power-at-this-HR
 * reading than an unflagged point. 0.15 was the value validated on real
 * held-out data (a meaningful, not dramatic, improvement -- see PLAN.md). */
const RECOVERY_DOWNWEIGHT_FACTOR = 0.15;

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 75;

function daysAgo(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
}

export interface HrPowerCalibration {
  /** bpm per W/kg of gross (terrain-adjusted) power. */
  slope: number;
  /** bpm, at zero power -- not a physiologically meaningful resting HR on
   * its own (the fit is only ever evaluated in the athlete's real running
   * power range), just the line's own y-intercept. */
  intercept: number;
  /** Weighted R² -- how well HR actually tracks this athlete's power. A
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

/** Trailing max of an already-smoothed series, via a monotonic deque --
 * O(n) total, not O(n*windowS). Shared shape by trailingMaxHr below. */
function trailingMaxSmoothed(smoothed: number[], tHoursArr: number[], windowS: number): number[] {
  const out: number[] = new Array(smoothed.length);
  const maxDeque: number[] = [];
  for (let i = 0; i < smoothed.length; i++) {
    while (maxDeque.length > 0 && smoothed[maxDeque[maxDeque.length - 1]] <= smoothed[i]) maxDeque.pop();
    maxDeque.push(i);
    while (tHoursArr[i] * 3600 - tHoursArr[maxDeque[0]] * 3600 > windowS) maxDeque.shift();
    out[i] = smoothed[maxDeque[0]];
  }
  return out;
}

function trailingMaxHr(race: EffortTrendPoint[], windowS: number): number[] {
  const out: number[] = new Array(race.length);
  const maxDeque: number[] = [];
  for (let i = 0; i < race.length; i++) {
    const hr = race[i].heartRateBpm ?? -Infinity;
    while (maxDeque.length > 0 && (race[maxDeque[maxDeque.length - 1]].heartRateBpm ?? -Infinity) <= hr) maxDeque.pop();
    maxDeque.push(i);
    while (race[i].tHours * 3600 - race[maxDeque[0]].tHours * 3600 > windowS) maxDeque.shift();
    out[i] = race[maxDeque[0]].heartRateBpm ?? hr;
  }
  return out;
}

interface Sample {
  hr: number;
  powerWPerKg: number;
  weight: number;
}

/** Builds the weighted (hr, power) sample pool for one race: start-trim +
 * early-window gated, GPS-spike-filtered, recency- and recovery-lag-
 * weighted. Shared by the pooled fit below. */
function collectRaceSamples(race: EffortTrendPoint[], recencyWeightForRace: number): Sample[] {
  if (race.length === 0) return [];
  const raceDurationHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
  if (!(raceDurationHours > 0)) return [];
  const earlyCutoffHours = raceDurationHours * EARLY_WINDOW_FRACTION;
  const startCutoffHours = START_TRIM_MINUTES / 60;

  const smoothedPower = trailingMeanPower(race, POWER_SMOOTHING_WINDOW_S);
  const tHoursArr = race.map((p) => p.tHours);
  const recentMaxPower = trailingMaxSmoothed(smoothedPower, tHoursArr, RECOVERY_LOOKBACK_S);
  const recentMaxHr = trailingMaxHr(race, RECOVERY_LOOKBACK_S);

  const samples: Sample[] = [];
  race.forEach((p, i) => {
    if (p.tHours < startCutoffHours || p.tHours >= earlyCutoffHours) return;
    if (p.heartRateBpm === undefined) return;
    if (p.dtS < MIN_SEGMENT_DT_S || p.grossPowerWPerKg > MAX_PLAUSIBLE_POWER_W_PER_KG) return;

    const powerDecayRatio = recentMaxPower[i] > 0 ? smoothedPower[i] / recentMaxPower[i] : 1;
    const hrProximityRatio = recentMaxHr[i] > 0 ? p.heartRateBpm / recentMaxHr[i] : 1;
    const recoveryFlagged = powerDecayRatio < RECOVERY_DECAY_THRESHOLD && hrProximityRatio >= RECOVERY_HR_PROXIMITY_THRESHOLD;
    const weight = p.dtS * recencyWeightForRace * (recoveryFlagged ? RECOVERY_DOWNWEIGHT_FACTOR : 1);
    samples.push({ hr: p.heartRateBpm, powerWPerKg: smoothedPower[i], weight });
  });
  return samples;
}

/**
 * Fits `heartRateBpm ≈ intercept + slope * grossPowerWPerKg` via weighted
 * least squares, pooling qualifying points (has HR, within the early
 * window of its own race, GPS-artifact-filtered) across every race
 * supplied, weighted by segment duration, race recency, and recovery-lag
 * confidence. Returns null if fewer than MIN_FIT_POINTS points qualify, or
 * if pooled power shows no variance to regress against.
 *
 * Restricted to races at least as long as the incoming reference tau (see
 * `poolIndicesInformativeAtReference`'s own doc), falling back to every
 * race if too few clear that bar, and to points past START_TRIM_MINUTES
 * into each race -- see this file's header doc and START_TRIM_MINUTES'
 * own doc for why (short-race start-transient contamination, confirmed on
 * real held-out data).
 *
 * Side effect worth knowing: for an athlete whose confirmed races are
 * mostly long (ultras), this restriction can end up excluding EVERY short
 * race from the fit, leaving the near-LT2/short-race end of the line pure
 * extrapolation from long-race (lower power) data -- exactly the failure
 * mode `lockThroughLt2` exists to close, by forcing the fit through the
 * athlete's own lab-measured LT2 pace+HR exactly rather than leaving it as
 * extrapolation. Checked directly (leave-one-out against 3 real races):
 * locking through LT2 improved ALL THREE races simultaneously here (unlike
 * the earlier effortFraction-based fit, where locking helped the anchored
 * race but measurably hurt the others) -- the tradeoff that motivated the
 * softer 25%-blend design in the old effortFraction fit doesn't reappear
 * in power space, so this fit locks rather than blends when an LT2 anchor
 * is available.
 */
export function fitHrToPowerCalibrationAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: {
    raceDates?: (Date | null)[];
    halfLifeDays?: number;
    now?: Date;
    /** Lab-measured (hr, powerWPerKg) anchor points -- see
     * `buildThresholdPowerAnchorPoints` -- blended into the SAME regression
     * as the pooled race data (all of them EXCEPT lockThroughLt2, which is
     * forced through exactly rather than blended). Undefined or empty is
     * byte-for-byte identical to omitting this option. */
    thresholdAnchors?: { hr: number; powerWPerKg: number }[];
    /** When provided, the fit is forced through this exact point (see this
     * function's own doc) instead of the plain weighted-least-squares
     * intercept/slope. By convention the caller's own LT2 anchor, when
     * available -- the one point real leave-one-out testing validated
     * locking through. Should also appear in thresholdAnchors when both are
     * passed together, so callers don't have to compute it twice; this
     * function does not add it to the blended pool itself. */
    lockThroughLt2?: { hr: number; powerWPerKg: number };
  } = {},
): HrPowerCalibration | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const totalMinPerRace = races.map((race) => (race.length > 0 ? Math.max(...race.map((p) => p.tHours + p.dtS / 3600)) * 60 : 0));
  const longEnoughIndices = new Set(poolIndicesInformativeAtReference(totalMinPerRace, ceilingParams));

  const samples: Sample[] = [];
  const contributingRaceIndices = new Set<number>();

  races.forEach((race, raceIndex) => {
    if (!longEnoughIndices.has(raceIndex)) return;
    const date = opts.raceDates?.[raceIndex] ?? null;
    const recencyWeight = date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1;
    const raceSamples = collectRaceSamples(race, recencyWeight);
    if (raceSamples.length > 0) contributingRaceIndices.add(raceIndex);
    samples.push(...raceSamples);
  });

  if (samples.length < MIN_FIT_POINTS) return null;

  // Blended in AFTER the MIN_FIT_POINTS gate above -- anchors alone (2-4
  // points) should never let a fit through that real race data couldn't on
  // its own; they adjust an already-qualifying fit, not substitute for one.
  // Compared by VALUE, not reference -- callers build lockThroughLt2 and
  // thresholdAnchors' own LT2 entry as separate object literals from the
  // same formula, so reference equality would silently fail to exclude it
  // here, double-counting LT2 as both locked AND blended.
  const blendedAnchors = (opts.thresholdAnchors ?? []).filter(
    (a) => !opts.lockThroughLt2 || a.hr !== opts.lockThroughLt2.hr || a.powerWPerKg !== opts.lockThroughLt2.powerWPerKg,
  );
  if (blendedAnchors.length > 0) {
    const raceWeightTotal = samples.reduce((s, p) => s + p.weight, 0);
    const anchorWeightEach = (raceWeightTotal * THRESHOLD_ANCHOR_WEIGHT_FRACTION) / blendedAnchors.length;
    for (const anchor of blendedAnchors) {
      samples.push({ hr: anchor.hr, powerWPerKg: anchor.powerWPerKg, weight: anchorWeightEach });
    }
  }

  const sumW = samples.reduce((s, p) => s + p.weight, 0);
  if (!(sumW > 0)) return null;

  if (opts.lockThroughLt2) {
    const anchor = opts.lockThroughLt2;
    let sXY = 0;
    let sXX = 0;
    let sYY = 0;
    for (const p of samples) {
      const dPower = p.powerWPerKg - anchor.powerWPerKg;
      const dHr = p.hr - anchor.hr;
      sXY += p.weight * dPower * dHr;
      sXX += p.weight * dPower * dPower;
      sYY += p.weight * dHr * dHr;
    }
    if (!(sXX > 0)) return null;
    const slope = sXY / sXX;
    const intercept = anchor.hr - slope * anchor.powerWPerKg;
    const rSquared = sXX > 0 && sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 0;
    return { slope, intercept, rSquared, pointCount: samples.length, raceCount: contributingRaceIndices.size };
  }

  const meanPower = samples.reduce((s, p) => s + p.weight * p.powerWPerKg, 0) / sumW;
  const meanHr = samples.reduce((s, p) => s + p.weight * p.hr, 0) / sumW;

  let sXY = 0;
  let sXX = 0;
  let sYY = 0;
  for (const p of samples) {
    const dPower = p.powerWPerKg - meanPower;
    const dHr = p.hr - meanHr;
    sXY += p.weight * dPower * dHr;
    sXX += p.weight * dPower * dPower;
    sYY += p.weight * dHr * dHr;
  }
  if (!(sXX > 0)) return null; // no power variance to regress against

  const slope = sXY / sXX;
  const intercept = meanHr - slope * meanPower;
  const rSquared = sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 0;

  return {
    slope,
    intercept,
    rSquared,
    pointCount: samples.length,
    raceCount: contributingRaceIndices.size,
  };
}

/**
 * Total weight given to the lab-threshold anchor points that AREN'T being
 * locked through exactly (see `fitHrToPowerCalibrationAcrossRaces`'s
 * `lockThroughLt2` option) -- LT1 and/or fat-ox points, as a fraction of
 * the race-pooled data's own total weight. Split evenly across however
 * many such points exist, so they can meaningfully pull the fit without a
 * handful of points ever outvoting the athlete's own race history. Mirrors
 * the old effortFraction fit's own anchor-blend fraction.
 */
const THRESHOLD_ANCHOR_WEIGHT_FRACTION = 0.25;

/** Predicted gross power (W/kg) at a given heart rate under a fitted
 * calibration -- usable anywhere pace-derived power is (e.g.
 * substrate.ts's splitPower/bonkPowerWPerKg). */
export function predictPowerFromHr(heartRateBpm: number, calibration: HrPowerCalibration): number {
  return (heartRateBpm - calibration.intercept) / calibration.slope;
}

/** Inverse of predictPowerFromHr -- estimates the heart rate this athlete
 * would likely show at a given gross power, for a Planning-mode course
 * where there's no recorded HR yet to work from (see chartData.ts's
 * ChartPoint.estimatedHeartRateBpm). Same caveats as the calibration
 * itself: a rough, athlete-specific estimate, not a guarantee -- cardiac
 * drift means it should read low for effort sustained deep into a long
 * race, and this doesn't attempt to model that. */
export function predictHeartRateFromPower(powerWPerKg: number, calibration: HrPowerCalibration): number {
  return calibration.intercept + calibration.slope * powerWPerKg;
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
 * Builds (hr, powerWPerKg) anchor points from the athlete's own
 * LAB-MEASURED thresholds/fat-ox test. LT1/LT2 fractions are already
 * expressed in %VO2max terms, so converting to power just needs
 * `maxAerobicPower` (the athlete's 100%-VO2max power, altitude-adjusted,
 * duration-independent) -- no Minetti pace conversion needed for those two.
 * Fat-ox points ARE recorded in pace terms, so they go through the same
 * pace -> gross power conversion the rest of this app uses
 * (paceToGrossPowerWPerKg) directly -- no further %VO2max step needed,
 * since the target here is power, not a normalized fraction. Unlike the
 * old effortFraction version of this function, the LT2 point's power value
 * is NOT tautologically fixed by construction (it genuinely depends on the
 * entered lt2Fraction and VO2max) -- a real consequence of dropping the
 * ceiling-fraction normalization, not a design choice made for this
 * reason specifically.
 */
export function buildThresholdPowerAnchorPoints(
  inputs: ThresholdCalibrationInputs,
  ceilingParams: CeilingParams,
): { hr: number; powerWPerKg: number }[] {
  const maxAerobic = maxAerobicPower(0, ceilingParams);
  if (!(maxAerobic > 0)) return [];

  const points: { hr: number; powerWPerKg: number }[] = [];
  if (inputs.lt1HeartRateBpm !== null) {
    points.push({ hr: inputs.lt1HeartRateBpm, powerWPerKg: inputs.lt1Fraction * maxAerobic });
  }
  if (inputs.lt2HeartRateBpm !== null) {
    points.push({ hr: inputs.lt2HeartRateBpm, powerWPerKg: inputs.lt2Fraction * maxAerobic });
  }
  for (const p of inputs.fatOxPoints) {
    if (p.heartRateBpm === undefined) continue;
    points.push({ hr: p.heartRateBpm, powerWPerKg: paceToGrossPowerWPerKg(p.paceMinPerKm, inputs.walkMaxMs) });
  }
  return points;
}

/**
 * Fits the same heartRateBpm ≈ intercept + slope·powerWPerKg shape as
 * fitHrToPowerCalibrationAcrossRaces, but from the athlete's own
 * lab-measured thresholds/fat-ox test alone, for use as a fallback when
 * there isn't enough (or any) race data to support the pooled fit -- see
 * runFitBatch.ts's marginCalibration fallback.
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
export function fitHrToPowerCalibrationFromThresholds(
  inputs: ThresholdCalibrationInputs,
  ceilingParams: CeilingParams,
): HrPowerCalibration | null {
  const points = buildThresholdPowerAnchorPoints(inputs, ceilingParams);
  if (points.length < 2) return null;

  const n = points.length;
  const meanPower = points.reduce((s, p) => s + p.powerWPerKg, 0) / n;
  const meanHr = points.reduce((s, p) => s + p.hr, 0) / n;
  let sXY = 0;
  let sXX = 0;
  let sYY = 0;
  for (const p of points) {
    const dPower = p.powerWPerKg - meanPower;
    const dHr = p.hr - meanHr;
    sXY += dPower * dHr;
    sXX += dPower * dPower;
    sYY += dHr * dHr;
  }
  if (!(sXX > 0)) return null;

  const slope = sXY / sXX;
  const intercept = meanHr - slope * meanPower;
  const rSquared = sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 1;

  return { slope, intercept, rSquared, pointCount: points.length, raceCount: points.length };
}
