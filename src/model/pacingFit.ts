// Infers the pacing-fade time constant (tau) -- and, as a lower-confidence
// alternative, durability drift -- from a recorded run's actual effort-vs-
// ceiling trend. See PLAN.md's pacing-curve section for what these knobs mean.
//
// Only tau is really identifiable from a single race. f0 lives inside the
// LT2-capped plateau at the very start of the sustainable-fraction curve
// (with defaults, the raw curve doesn't drop below LT2 until ~40 minutes in)
// and can't be recovered once decay has actually begun; fInf is an asymptote
// a several-hour race never reaches; and durability drift is linear-in-time,
// which looks nearly identical in shape to exponential decay over one race's
// duration window, so fitting both drift and tau from the same trend isn't
// well-determined. This holds f0/fInf/lt2Fraction (and, for the tau fit,
// drift) at whatever's currently configured and searches only the one
// parameter a single race actually constrains.

import type { CourseSegment, SurfaceCategory } from "../gpx/pipeline";
import type { AnalysisSegmentResult } from "./analysis";
import {
  altitudeFraction,
  CEILING_DEFAULTS,
  type CeilingParams,
  ceilingPower,
  sustainableFraction,
} from "./ceiling";
import { O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L, vo2ToPower } from "./energetics";
import { descentStepForSegment } from "./descentImpact";
import { fitIntensityConditionedSlowdownModel } from "./intensityConditionedSlowdownFit";
import {
  DEFAULT_DESCENT_CAP_CURVE,
  DEFAULT_DESCENT_PACING_CURVE,
  type DescentCapCurve,
  type DescentPacingCurve,
  descentPacingMultiplier,
  GRADE_CLAMP,
  gradeOnlyMaxDescentSpeedMs,
} from "./minetti";
import type { TaggedMonotonicSegment } from "./segmentLibrary";
import { findSustainableTheta, type SolverInputs } from "./solver";

export interface EffortTrendPoint {
  /** Hours elapsed since the start of the run, at the start of this segment. */
  tHours: number;
  grossPowerWPerKg: number;
  altitudeM: number;
  /** Segment duration, seconds -- used as the regression weight. */
  dtS: number;
  /**
   * Cumulative descent-based exposure accumulated *before* this segment
   * (same "so far, at the start of this segment" convention as tHours) --
   * three parallel readings (PLAN.md §12/§13 stage 5), one per candidate
   * descent-exposure basis. Optional so existing hand-built points (tests,
   * or any future caller that doesn't care about descent drift) don't need
   * to supply them; fitDurabilityDriftPerDescentUnit treats a missing value
   * as 0 exposure.
   */
  cumulativeDescentM?: number;
  cumulativeDescentImpact?: number;
  cumulativeDescentImpactSquared?: number;
  /**
   * True if this segment's own terrain is classified unpaved (see
   * surfaceExposure.ts's attachSurfaceData), false if known paved,
   * undefined if no surface data was ever attached to this race. Per-point
   * (not cumulative, unlike the descent fields above) -- fitUnpavedCostMultiplier
   * drives a flat instantaneous cost effect, not an accumulating one, so it
   * only needs to know whether *this* segment itself was unpaved.
   */
  surfaceUnpaved?: boolean;
  /** Recorded heart rate at this segment, if the source GPX had it (see
   * gpx/pipeline.ts's CourseSegment.heartRateBpm) -- undefined if this run
   * has no HR data at all. See hrCalibration.ts's own doc for why this is
   * reference data for most fits in this file but the one thing
   * fitHrToPowerCalibrationAcrossRaces actually regresses against. */
  heartRateBpm?: number;
}

/**
 * Running per-segment descent sums as of the *start* of each courseSegments
 * index -- i.e. not yet including that segment's own descent, mirroring how
 * tHours excludes the current segment's own duration. Kept as a single
 * one-pass walk (shared by every analysisSegments entry that lands on a
 * given index) rather than recomputing descentImpact.ts's whole-array sums
 * per point.
 */
function cumulativeDescentBeforeEachSegment(
  courseSegments: CourseSegment[],
): { m: number; impact: number; impactSquared: number }[] {
  const result: { m: number; impact: number; impactSquared: number }[] = [];
  let m = 0;
  let impact = 0;
  let impactSquared = 0;
  let previousElevation: number | null = null;
  for (const seg of courseSegments) {
    result.push({ m, impact, impactSquared });
    const { descentM, speedMs } = descentStepForSegment(seg, previousElevation);
    previousElevation = seg.elevation;
    if (speedMs !== null) {
      m += descentM;
      impact += descentM * speedMs;
      impactSquared += descentM * speedMs * speedMs;
    }
  }
  return result;
}

/**
 * Raw (grossPower, elapsed time, altitude) per moving segment, from an
 * already-run analyzeRun() -- the fit needs to recompute the ceiling at many
 * candidate params, so it needs the underlying power, not just the
 * effortFraction ratio (which is pinned to whatever ceilingParams analyzeRun
 * was called with).
 */
export function buildEffortTrendPoints(
  courseSegments: CourseSegment[],
  analysisSegments: AnalysisSegmentResult[],
  altitudeAdjustment: boolean,
): EffortTrendPoint[] {
  const cumulativeDescent = cumulativeDescentBeforeEachSegment(courseSegments);
  return analysisSegments
    .filter((s) => s.effortFraction !== null)
    .map((s) => ({
      tHours: (s.cumulativeElapsedTimeS - s.timeS) / 3600,
      grossPowerWPerKg: s.grossPowerWPerKg,
      altitudeM: altitudeAdjustment ? courseSegments[s.index]?.elevation ?? 0 : 0,
      dtS: s.timeS,
      cumulativeDescentM: cumulativeDescent[s.index]?.m ?? 0,
      cumulativeDescentImpact: cumulativeDescent[s.index]?.impact ?? 0,
      cumulativeDescentImpactSquared: cumulativeDescent[s.index]?.impactSquared ?? 0,
      surfaceUnpaved: courseSegments[s.index]?.surfaceUnpaved,
      heartRateBpm: courseSegments[s.index]?.heartRateBpm ?? undefined,
    }));
}

export interface TrendFit {
  /** Effort-fraction change per hour (e.g. 0.05 = effort rising ~5 percentage points/hour). */
  slopePerHour: number;
}

/** Weighted least-squares slope of effort (grossPower/ceiling) vs. elapsed hours.
 * Exported for reuse by withinRaceDescentDiagnostic.ts, which needs the same
 * slope computation restricted to a sub-window of a race's points.
 *
 * descentExposureSelector is optional and omitted by every caller except
 * fitDurabilityDriftPerDescentUnit below -- when provided, it's read off
 * each point and passed through to ceilingPower as descentExposure, so the
 * descent-based drift term (if ceilingParams.durabilityDriftPerDescentUnit
 * is set) actually has something to act on. Omitting it leaves behavior
 * byte-for-byte identical to before this parameter existed.
 */
export function computeEffortTrend(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  descentExposureSelector?: (p: EffortTrendPoint) => number,
): TrendFit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  for (const p of points) {
    const ceiling = ceilingPower(
      {
        tMin: p.tHours * 60,
        altitudeM: p.altitudeM,
        elapsedHours: p.tHours,
        ...(descentExposureSelector ? { descentExposure: descentExposureSelector(p) } : {}),
      },
      ceilingParams,
    );
    if (ceiling <= 0) continue;
    const y = p.grossPowerWPerKg / ceiling;
    xs.push(p.tHours);
    ys.push(y);
    ws.push(p.dtS);
    sumW += p.dtS;
    sumWX += p.dtS * p.tHours;
    sumWY += p.dtS * y;
  }
  if (sumW <= 0) return null;

  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ws[i] * (xs[i] - meanX) * (ys[i] - meanY);
    sxx += ws[i] * (xs[i] - meanX) ** 2;
  }
  if (sxx <= 0) return null;
  return { slopePerHour: sxy / sxx };
}

/** Bin width for computeFadeTrend's peak-based regression, minutes -- coarse
 * enough that most 30-min windows during a multi-hour effort contain both
 * running and walk-break/rest segments, giving the percentile below
 * something real to separate from the average. */
const PEAK_TREND_BIN_MINUTES = 30;
/** How far into each bin's distribution computeFadeTrend looks for "the
 * best you could still do right now" -- high enough to sit near the top of
 * a bin's running segments rather than its walk breaks, not so high it's
 * just the single fastest instant in the bin. */
const PEAK_TREND_PERCENTILE = 0.9;
/** A bin needs at least this many raw points before its percentile means
 * anything, rather than being one noisy point standing in for the whole
 * window. */
const MIN_POINTS_PER_PEAK_BIN = 3;
/** Below this many usable bins there isn't enough resolution to regress on
 * binned peaks at all -- computeFadeTrend falls back to computeEffortTrend
 * instead (see that function's own doc for why this is a safe no-op on
 * short/sparse data). */
const MIN_PEAK_BINS = 4;

function percentileOfSorted(sortedValues: number[], p: number): number {
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * (sortedValues.length - 1))));
  return sortedValues[idx];
}

/**
 * Peak-based alternative to computeEffortTrend's flat time-weighted
 * average, used by the tau/fInf fitters below (NOT by the durability-drift
 * fitters or withinRaceDescentDiagnostic.ts, which still use
 * computeEffortTrend directly -- those weren't part of the investigation
 * this was built for).
 *
 * The problem this fixes: on a real recorded ultra, the flat weighted
 * average can look nearly trendless even when the athlete is genuinely
 * fading, because increasing walk-break/rest time later in a race dilutes
 * the average right alongside any real decline in the *achievable*
 * ceiling -- the average conflates "genuinely fatigued" with "chose to
 * walk here," two physiologically different things. Binning into fixed
 * windows and taking a high percentile within each window isolates the
 * former from the latter. Confirmed against a real athlete's raw heart
 * rate (a completely unmodeled signal, no ceiling/tau involved at all) and
 * against Strava's own Grade Adjusted Pace chart on a 24h+ ultra -- both
 * show a clear decline the flat weighted average missed, and a backtest
 * fitting tau against this peak signal instead measurably improved
 * held-out finish-time prediction (21.0% -> 17.3% mean error across 47 real
 * races) over the flat-average fit it replaces here.
 *
 * Falls back to computeEffortTrend when there aren't enough usable bins:
 * this makes the switch a strict no-op on every existing synthetic test
 * fixture in this file (they're noiseless -- a percentile of constant
 * values equals the mean, so the two methods agree whenever there's enough
 * data for the peak method to run at all) and on any race too short/sparse
 * to bin meaningfully, so it only changes behavior on real, noisy,
 * walk-break-diluted, multi-hour data -- exactly where it's needed.
 */
/**
 * Per-point values that do NOT depend on fInf/tauMin, cached per points
 * array so a tau/fInf grid search stops recomputing them for every
 * candidate. This is the hot loop of the whole fit: with ~75 races and
 * ~80k trend points, the searches below call computeFadeTrend hundreds of
 * times, and each call was re-deriving the altitude fraction, the
 * durability-drift factor, and each point's bin index -- none of which move
 * as fInf/tau vary -- as well as allocating a fresh { ...DEFAULTS,
 * ...params } object inside ceilingPower for every single point.
 *
 * Deliberately caches only the params-INDEPENDENT parts, and the consuming
 * loop below reassembles the ceiling with exactly the same arithmetic, in
 * the same order, that ceilingPower uses (fraction * altFraction *
 * vo2Max -> vo2ToPower -> drift). The results are therefore bit-identical,
 * not merely close -- there's a test pinning that.
 *
 * Keyed by array identity in a WeakMap: trimForPacingFit returns a stable
 * array per race per fit, and entries disappear with the race data.
 */
interface PreparedFadeRace {
  altFraction: Float64Array;
  driftFactor: Float64Array;
  gross: Float64Array;
  tMin: Float64Array;
  binOffset: Int32Array;
  binCount: number;
  firstBin: number;
  /**
   * Memoized trend per (fInf, tau, ...) signature for THIS race. The
   * bootstrap resamples the same race pool 100 times WITH REPLACEMENT, so a
   * single objective evaluation already asks for the same race at the same
   * tau several times over (~37% of draws are duplicates at this pool
   * size), and the coarse/fine passes of one tau search revisit values too.
   * Cache hits return the identical numbers, so this is exact, not an
   * approximation. Bounded because tau candidates are floats and a long
   * bootstrap would otherwise grow this without limit.
   */
  trendCache: Map<string, TrendFit | null>;
  /** Guards the cache against a params change that WOULD move these values
   * (vo2Max, altitude toggling, drift rate) rather than silently reusing
   * stale numbers. */
  signature: string;
}

const preparedFadeRaces = new WeakMap<EffortTrendPoint[], PreparedFadeRace>();

function prepareFadeRace(points: EffortTrendPoint[], merged: Required<CeilingParams>): PreparedFadeRace {
  const signature = `${merged.vo2MaxMlPerKgPerMin}|${merged.durabilityDriftPerHour}|${merged.pacingCurveEnabled}`;
  const cached = preparedFadeRaces.get(points);
  if (cached && cached.signature === signature) return cached;

  const binHours = PEAK_TREND_BIN_MINUTES / 60;
  const firstBin = Math.floor(points[0].tHours / binHours);
  const lastBin = Math.floor(points[points.length - 1].tHours / binHours);
  const n = points.length;
  const prepared: PreparedFadeRace = {
    altFraction: new Float64Array(n),
    driftFactor: new Float64Array(n),
    gross: new Float64Array(n),
    tMin: new Float64Array(n),
    binOffset: new Int32Array(n),
    binCount: lastBin - firstBin + 1,
    firstBin,
    signature,
    trendCache: new Map(),
  };
  for (let i = 0; i < n; i++) {
    const p = points[i];
    prepared.altFraction[i] = altitudeFraction(p.altitudeM ?? 0);
    prepared.gross[i] = p.grossPowerWPerKg;
    prepared.tMin[i] = p.tHours * 60;
    prepared.binOffset[i] = Math.floor(p.tHours / binHours) - firstBin;
    prepared.driftFactor[i] =
      merged.pacingCurveEnabled && merged.durabilityDriftPerHour > 0
        ? Math.max(0, 1 - merged.durabilityDriftPerHour * p.tHours)
        : 1;
  }
  preparedFadeRaces.set(points, prepared);
  return prepared;
}

export function computeFadeTrend(points: EffortTrendPoint[], ceilingParams: CeilingParams): TrendFit | null {
  if (points.length === 0) return computeEffortTrend(points, ceilingParams);

  // Plain array of bins (points are already time-ordered, so this is just
  // an offset lookup) instead of a Map, and sort each bin's array in place
  // instead of copying it first -- this runs inside tau/fInf grid searches,
  // called for many candidate values per race per fit, so per-call overhead
  // compounds quickly.
  const binHours = PEAK_TREND_BIN_MINUTES / 60;
  const merged = { ...CEILING_DEFAULTS, ...ceilingParams };
  const prep = prepareFadeRace(points, merged);
  // Every field sustainableFraction actually reads -- a key that missed one
  // would serve a stale trend for genuinely different params.
  const cacheKey = `${merged.pacingCurveEnabled}|${merged.powerLawFraction60Min}|${merged.powerLawExponent}`;
  const memo = prep.trendCache.get(cacheKey);
  if (memo !== undefined) return memo;
  const firstBin = prep.firstBin;
  const bins: number[][] = Array.from({ length: prep.binCount }, () => []);
  for (let i = 0; i < prep.tMin.length; i++) {
    // Same arithmetic as ceilingPower, in the same order -- only the
    // params-independent factors come from the cache. See PreparedFadeRace.
    const fraction = sustainableFraction(prep.tMin[i], merged);
    const ceiling =
      vo2ToPower(fraction * prep.altFraction[i] * merged.vo2MaxMlPerKgPerMin, O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L) *
      prep.driftFactor[i];
    if (ceiling <= 0) continue;
    bins[prep.binOffset[i]].push(prep.gross[i] / ceiling);
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < bins.length; i++) {
    const vals = bins[i];
    if (vals.length < MIN_POINTS_PER_PEAK_BIN) continue;
    vals.sort((a, b) => a - b);
    xs.push((firstBin + i + 0.5) * binHours);
    ys.push(percentileOfSorted(vals, PEAK_TREND_PERCENTILE));
  }
  if (xs.length < MIN_PEAK_BINS) return rememberTrend(prep, cacheKey, computeEffortTrend(points, ceilingParams));

  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  if (sxx <= 0) return rememberTrend(prep, cacheKey, computeEffortTrend(points, ceilingParams));
  return rememberTrend(prep, cacheKey, { slopePerHour: sxy / sxx });
}

/** Bounded memo write -- see PreparedFadeRace.trendCache. */
const MAX_TREND_CACHE_ENTRIES = 4096;
function rememberTrend(prep: PreparedFadeRace, key: string, value: TrendFit | null): TrendFit | null {
  if (prep.trendCache.size >= MAX_TREND_CACHE_ENTRIES) prep.trendCache.clear();
  prep.trendCache.set(key, value);
  return value;
}

/**
 * Drops the first/last few minutes of a run from the fit window -- a
 * standstill start and a finish kick both fake a trend that isn't fatigue.
 * Trim is 5% of total duration, clamped to [5, 15] minutes either side.
 */
export function trimForPacingFit(points: EffortTrendPoint[]): EffortTrendPoint[] {
  if (points.length === 0) return points;
  const totalHours = points[points.length - 1].tHours;
  const trimHours = Math.min(15, Math.max(5, totalHours * 60 * 0.05)) / 60;
  return points.filter((p) => p.tHours >= trimHours && p.tHours <= totalHours - trimHours);
}

/** Exported for reuse by withinRaceDescentDiagnostic.ts's own late-window
 * point-count gate -- same numerical floor, not a new magic number. */
export const MIN_FIT_POINTS = 10;
/**
 * General guard against a pooled multi-race fit secretly being driven by
 * one race in disguise: an "unresponsive" race (see MultiRaceTauFitResult's
 * own doc) contributes an approximately-constant, near-zero term to the
 * pooled objective regardless of the candidate parameter, so it doesn't
 * meaningfully constrain where the fit lands -- only the non-unresponsive
 * ("informative") races actually do. If only one race is informative,
 * "pooled across N races" is misleading: the result is really just that
 * one race's own idiosyncratic pacing (which can be very unrepresentative
 * -- e.g. a looped/forced-pace format like a backyard ultra doesn't decay
 * the way a continuous-effort race does), dressed up as a multi-race
 * consensus. `informativeRaceCount` on each pooled result surfaces this so
 * callers can require at least this many informative races before trusting
 * the fit, exactly the way `durationDiversityRatio` already gates trust in
 * the joint fInf/tau fit -- not by special-casing any particular race, but
 * by generalizing "does this fit actually reflect more than one race?"
 * into a checkable number. See `scripts/backtestFinishTime.ts` for a
 * concrete three-tier fallback built on this (joint fit -> tau-only fit ->
 * hold current defaults), and `RunLibraryPanel.tsx` for the UI warning.
 */
export const MIN_INFORMATIVE_RACES = 2;
/** Default recency half-life for the multi-race tau fit -- mid-point of
 * PLAN.md §12's suggested 60-90 day range. */
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 75;

export interface FitTauAcrossRacesOptions {
  /** Aligned by index with `races`. A race with no known date (or when this
   * whole option is omitted) gets no recency discount -- weight 1. */
  raceDates?: (Date | null)[];
  halfLifeDays?: number;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

function daysAgo(date: Date, now: Date): number {
  return Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
}

/**
 * Same tau-only search as fitTauMinutes, but pooled across several races at
 * once: the objective is the sum of each race's own squared within-race
 * slope, not one regression over concatenated points (races run on
 * different days at different average efforts, so a flat pooled regression
 * would mostly reflect cross-race effort differences, not fatigue shape).
 * f0 still isn't fit here (this function holds both f0 and fInf fixed) --
 * see fitFInfAndTauAcrossRaces below for jointly fitting (fInf, tau), which
 * only became well-posed once f0 stays pinned (fitting f0 *and* fInf
 * together from within-race slopes alone is scale-invariant: an f0=fInf
 * flat ceiling of any level zeroes every race's slope). One extra race
 * beyond the tau fit's single-race case mainly buys robustness -- one tau
 * has to flatten several independent runs' trends at once, not just one
 * run's idiosyncrasies.
 *
 * Recency weighting (opts.raceDates/halfLifeDays) is what makes this "adapt
 * as the athlete trains" -- an older race's contribution to the pooled
 * objective decays over opts.halfLifeDays, so recent training dominates
 * without older races being discarded outright. This only applies here, not
 * in fitTauMinutes: a single race has no other race to be "more recent
 * than," so a recency weight there would just scale the whole objective by
 * a constant and never move the optimum.
 */
/** ceiling.ts's own DEFAULTS.tauMin -- not exported from there, so
 * restated here as the fallback reference when a caller's ceilingParams
 * doesn't set one (mirrors DEFAULT_LT2_FRACTION's own doc just below). */
export const DEFAULT_TAU_MIN_REFERENCE = 250;

/** PLAN.md §11's "~2x+ duration range" precondition for a jointly-fit fInf
 * to mean anything more than an unconstrained absorbing parameter. */
export const MIN_DURATION_DIVERSITY_RATIO = 2;
/** Linear-interpolation percentile over an already-sorted array. Shared by
 * bootstrapTauConfidenceInterval below and finishTimeRange.ts's own
 * percentile call on bootstrap finish times. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export interface BootstrapOptions {
  bootstrapSamples?: number;
  /** Injectable for deterministic tests -- defaults to Math.random. */
  rng?: () => number;
}

export const DEFAULT_BOOTSTRAP_SAMPLES = 100;
/**
 * Yield to the event loop this often during a bootstrap loop so the browser
 * tab stays responsive across ~100 sequential refits.
 *
 * 1, not 10: a single resample is a full tau refit across the whole race
 * pool, measured at ~2.5 SECONDS against a 168-run library. Yielding every
 * tenth one therefore froze the tab in ~25-second blocks for the several
 * minutes the bootstrap runs -- indistinguishable from a hang. One
 * setTimeout(0) per resample is negligible against 2.5s of work.
 */
export const BOOTSTRAP_YIELD_EVERY = 1;
export interface DriftFitResult {
  durabilityDriftPerHour: number;
  trendAtFitPctPerHour: number;
}

/**
 * Alternative, lower-confidence fit: holds tau/f0/fInf at whatever's
 * currently configured and searches durability drift instead. Meant to be
 * offered only as a secondary option when a tau-only fit can't flatten the
 * trend on its own -- see the module comment on why drift and tau aren't
 * jointly identifiable from one race.
 */
export function fitDurabilityDriftPerHour(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  range: [number, number] = [0, 0.06],
): DriftFitResult | null {
  const trimmed = trimForPacingFit(points);
  if (trimmed.length < MIN_FIT_POINTS) return null;

  const search = (lo: number, hi: number, step: number) => {
    let best = lo;
    let bestAbsSlope = Infinity;
    for (let drift = lo; drift <= hi; drift += step) {
      const trend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerHour: drift });
      if (trend && Math.abs(trend.slopePerHour) < bestAbsSlope) {
        bestAbsSlope = Math.abs(trend.slopePerHour);
        best = drift;
      }
    }
    return best;
  };

  const coarse = search(range[0], range[1], 0.002);
  const fine = search(Math.max(range[0], coarse - 0.0018), Math.min(range[1], coarse + 0.0018), 0.0002);

  const fittedTrend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerHour: fine });
  if (!fittedTrend) return null;

  return {
    durabilityDriftPerHour: fine,
    trendAtFitPctPerHour: fittedTrend.slopePerHour * 100,
  };
}

/** PLAN.md §12/§13 stage 5's three candidate descent-exposure metrics --
 * kept as live alternatives rather than picking one, since there's no
 * established result yet saying which scaling (raw descent, descent x
 * speed, or descent x speed^2) actually predicts muscular fatigue best. */
export type DescentExposureBasis = "descentMeters" | "descentImpact" | "descentImpactSquared";
/** Multiplier range searched below -- 1 (no penalty) to 4 (4x cost, i.e.
 * 300% slower on unpaved terrain), comfortably past the ~1.5x this was
 * validated at against real data, the same "let the range include plenty
 * of headroom past the expected answer" approach the other fits in this
 * file take. */
const UNPAVED_COST_MULTIPLIER_RANGE: [number, number] = [1, 4];

/** Reduced solver precision used only while *searching* for the multiplier
 * (comparing many candidates against real finish times is far more
 * expensive than the old effort-fraction-gap proxy, which needed no
 * simulation at all) -- adequate to reliably locate the right candidate,
 * not used for the real predictions solver.ts/analysis.ts make once a
 * multiplier is chosen and applied. */
const FIT_SEARCH_SOLVER_OPTIONS = { scanSteps: 12, iterations: 18 };

/** One training race for the fit below -- needs the full course (with
 * surface data already attached via surfaceExposure.ts's attachSurfaceData)
 * and the athlete's actual recorded finish time, not just the lightweight
 * EffortTrendPoint[] trend the other fits in this file use. */
export interface FinishTimeTrainingRace {
  segments: CourseSegment[];
  actualFinishTimeS: number;
}

export interface RaceUnpavedCostMultiplierResult {
  /** % error between the naive (multiplier=1) prediction and this race's
   * actual recorded finish time. */
  baselineErrPct: number;
  /** % error at the fitted multiplier. */
  fitErrPct: number;
  /** True if this race has no unpaved segments at all -- the multiplier
   * can't move its predicted finish time regardless of what it ends up
   * being, so it had no real say in the fit. */
  unresponsive: boolean;
}

export interface MultiRaceUnpavedCostMultiplierResult {
  unpavedCostMultiplier: number;
  perRace: RaceUnpavedCostMultiplierResult[];
  informativeRaceCount: number;
  hitSearchBoundary: "lower" | "upper" | null;
}

/**
 * Fits a flat, instantaneous cost multiplier applied to unpaved segments'
 * Minetti cost (see solver.ts/analysis.ts) -- terrain difficulty the grade/
 * altitude model alone doesn't capture. Chosen over an earlier cumulative-
 * exposure durability-drift design after a leave-one-out backtest across
 * real races showed this flat, no-carryover cost penalty fits far better.
 *
 * An earlier version of this fit searched for the multiplier that
 * equalized recorded effort fraction between unpaved and paved segments --
 * a real-data check found that gap is actually flat or slightly *negative*
 * (this athlete's own recorded power isn't elevated on unpaved terrain, if
 * anything slightly lower -- they simply move slower, likely a technical-
 * terrain speed constraint rather than a metabolic one), so that objective
 * structurally couldn't recover a multiplier anywhere near what a held-out
 * finish-time backtest showed the mechanism actually needs (~1.5x vs.
 * ~1.1x). This version fits directly against the objective that matters --
 * how well each candidate multiplier predicts each training race's own
 * actual finish time via the real solver -- holding tau/fInf fixed at
 * whatever's in ceilingParams, same "one axis at a time" approach as the
 * other fits in this file. Races with no unpaved segments at all can't
 * inform the search (the multiplier has zero effect on their prediction)
 * and are excluded from the objective, marked unresponsive rather than
 * silently pulling the fit toward "no penalty".
 *
 * Meaningfully more expensive than a trend-based fit: each candidate
 * multiplier requires a real forward-simulation solve per race, not just
 * arithmetic over already-computed points (see FIT_SEARCH_SOLVER_OPTIONS).
 */
export function fitUnpavedCostMultiplierAcrossRaces(
  races: FinishTimeTrainingRace[],
  ceilingParams: CeilingParams,
  commonInputs: Omit<SolverInputs, "segments" | "ceilingParams" | "unpavedCostMultiplier">,
  opts: FitTauAcrossRacesOptions = {},
): MultiRaceUnpavedCostMultiplierResult | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const withWeight = races
    .map((r, i) => {
      const date = opts.raceDates?.[i] ?? null;
      return {
        race: r,
        recencyWeight: date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1,
        hasUnpaved: r.segments.some((s) => s.surfaceUnpaved),
      };
    })
    .filter((r) => r.race.segments.length > 0 && r.race.actualFinishTimeS > 0);
  if (withWeight.length === 0) return null;

  const informative = withWeight.filter((r) => r.hasUnpaved);
  if (informative.length === 0) return null;

  const predictedFinishTimeS = (segments: CourseSegment[], multiplier: number): number => {
    const { result } = findSustainableTheta(
      { segments, ceilingParams, unpavedCostMultiplier: multiplier, ...commonInputs },
      FIT_SEARCH_SOLVER_OPTIONS,
    );
    return result.finishTimeS;
  };

  const errPctFor = (race: FinishTimeTrainingRace, multiplier: number): number =>
    (100 * Math.abs(predictedFinishTimeS(race.segments, multiplier) - race.actualFinishTimeS)) / race.actualFinishTimeS;

  const pooledSquaredErr = (multiplier: number) => {
    let sum = 0;
    for (const r of informative) {
      const err = errPctFor(r.race, multiplier) / 100;
      sum += r.recencyWeight * err * err;
    }
    return sum;
  };

  const [lo, hi] = UNPAVED_COST_MULTIPLIER_RANGE;
  const search = (searchLo: number, searchHi: number, step: number) => {
    let bestM = searchLo;
    let bestScore = Infinity;
    for (let m = searchLo; m <= searchHi; m += step) {
      const score = pooledSquaredErr(m);
      if (score < bestScore) {
        bestScore = score;
        bestM = m;
      }
    }
    return bestM;
  };

  // Coarser grid than the old trend-based fit -- each step here is a real
  // solver simulation per informative race, not free arithmetic.
  const coarseStep = (hi - lo) / 16;
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), coarseStep / 8);

  const unpavedCostMultiplier = fine;

  const boundaryEpsilon = (hi - lo) / 1000;
  const hitSearchBoundary =
    unpavedCostMultiplier <= lo + boundaryEpsilon ? "lower" : unpavedCostMultiplier >= hi - boundaryEpsilon ? "upper" : null;

  const perRace = withWeight.map((r) => ({
    baselineErrPct: errPctFor(r.race, 1),
    fitErrPct: errPctFor(r.race, unpavedCostMultiplier),
    unresponsive: !r.hasUnpaved,
  }));

  return {
    unpavedCostMultiplier,
    perRace,
    informativeRaceCount: informative.length,
    hitSearchBoundary,
  };
}

export interface SurfaceCostMultiplierFitResult {
  surfaceCostMultipliers: Partial<Record<SurfaceCategory, number>>;
  runCount: number;
  segmentCount: number;
  /** Within-run R^2 of the underlying regression -- NOT a fit-quality gate
   * on its own (see intensityConditionedSlowdownFit.ts's own doc: this is
   * inflated by circularity for the power-based intensity arms), kept here
   * purely for display alongside the multipliers. */
  rSquaredWithinRun: number;
  /** Parallel to surfaceCostMultipliers -- variance inflation per category,
   * same rule-of-thumb concern threshold (~5-10) as linearSolve.ts's own
   * doc. A caller can flag a specific category as shaky without discarding
   * the whole fit. */
  variableInflationFactors: Partial<Record<SurfaceCategory, number>>;
}

const NON_SURFACE_INTENSITY_FIT_COLUMNS = new Set(["intensity", "grade", "gradeSquared", "aerobicClock", "impact"]);

/**
 * Per-surface-category cost multiplier fit, replacing the flat
 * fitUnpavedCostMultiplierAcrossRaces mechanism above with one that doesn't
 * depend on findSustainableTheta's zero-margin max-sustainable-effort
 * assumption at all. That assumption is what made the flat fit's own
 * finish-time backtest arbiter unable to tell "the terrain model is wrong"
 * apart from "the athlete doesn't actually race at the theoretical ceiling"
 * -- a real, ~30% uniform under-prediction bias that persists even on
 * held-out real races (see PLAN.md §14 stage 6's follow-up). This fit
 * sidesteps the whole question: it conditions on the athlete's own recorded
 * heart rate as the effort signal (intensityConditionedSlowdownFit.ts's
 * "pulse" basis -- the one candidate that doesn't move in lockstep with
 * pace, so a genuine surface-driven slowdown stays visible at matched
 * effort) and asks directly "how much slower at the SAME intensity", never
 * invoking the solver or any notion of a sustainable ceiling. Unlike the
 * flat fit, this does NOT need restricting to sustained-effort/race-paced
 * runs -- an easy run's own paved-vs-unpaved segments are still valid,
 * matched-intensity information here, so a broader pool is strictly more
 * statistical power, not contamination.
 *
 * Coefficients convert to solver.ts SurfaceCostMultipliers via
 * multiplier = exp(-coefficient), the same convention
 * backtestSurfaceMultiplier.ts's own held-out comparison uses (terrain
 * multiplier divides speed for a fixed target power).
 */
export function fitSurfaceCostMultipliersFromIntensity(
  library: TaggedMonotonicSegment[],
): SurfaceCostMultiplierFitResult | null {
  const fit = fitIntensityConditionedSlowdownModel(library, {
    intensityBasis: "pulse",
    aerobicClockBasis: "elapsedHours",
    impactBasis: "descentMeters",
  });
  if (!fit) return null;

  const surfaceCostMultipliers: Partial<Record<SurfaceCategory, number>> = {};
  const variableInflationFactors: Partial<Record<SurfaceCategory, number>> = {};
  for (let i = 0; i < fit.columns.length; i++) {
    const col = fit.columns[i];
    if (NON_SURFACE_INTENSITY_FIT_COLUMNS.has(col)) continue;
    const category = col as SurfaceCategory;
    surfaceCostMultipliers[category] = Math.exp(-fit.coefficients[i]);
    variableInflationFactors[category] = fit.variableInflationFactors[i];
  }

  return {
    surfaceCostMultipliers,
    runCount: fit.runCount,
    segmentCount: fit.segmentCount,
    rSquaredWithinRun: fit.rSquaredWithinRun,
    variableInflationFactors,
  };
}

/**
 * One race's descent-pacing observation: how fast this athlete ACTUALLY ran
 * the descent-cap-eligible stretches, relative to the unscaled grade-only
 * cap (minetti.ts's gradeOnlyMaxDescentSpeedMs) over those same stretches.
 * The denominator must always be the UNSCALED cap -- using the already-
 * scaled maxDescentSpeedMs would make the fit circular (fitting a
 * multiplier against a target that already has one applied).
 */
export interface DescentPacingObservation {
  totalDistanceKm: number;
  /** Distance-weighted mean actual speed / distance-weighted mean grade-only
   * cap, over this race's cap-eligible segments. */
  ratio: number;
}

/**
 * Builds a DescentPacingObservation from one race's recorded segments, or
 * null when the race has too little cap-eligible descent to say anything
 * (a flat road race constrains this curve not at all, and averaging over a
 * handful of segments would be noise, not signal).
 */
export function buildDescentPacingObservation(
  segments: CourseSegment[],
  minCapEligibleDistanceM = 200,
): DescentPacingObservation | null {
  let weightedActual = 0;
  let weightedCap = 0;
  let capEligibleDistanceM = 0;
  let totalDistanceM = 0;
  for (const seg of segments) {
    totalDistanceM = Math.max(totalDistanceM, seg.cumulativeDistance3D);
    const cap = gradeOnlyMaxDescentSpeedMs(seg.gradient);
    if (!Number.isFinite(cap)) continue;
    if (seg.dtS === null || seg.dtS <= 0 || seg.paused) continue;
    const speed = seg.distance3D / seg.dtS;
    weightedActual += speed * seg.distance3D;
    weightedCap += cap * seg.distance3D;
    capEligibleDistanceM += seg.distance3D;
  }
  if (capEligibleDistanceM < minCapEligibleDistanceM || weightedCap <= 0 || totalDistanceM <= 0) return null;
  return {
    totalDistanceKm: totalDistanceM / 1000,
    ratio: weightedActual / weightedCap,
  };
}

/**
 * Minimum spread between the shortest and longest race in the pool before
 * the full three-parameter (f0, fInf, tauKm) curve is identifiable at all.
 * Directly motivated by a real observed failure: a leakage-free refit on 3
 * races clustered at 17/56/57km returned fInf=0.33 with SSE=0.0043 -- a
 * near-perfect fit whose asymptote was pure extrapolation, since no race in
 * the pool was long enough to constrain it. The same fit with races out to
 * 113km gave fInf=0.64. A near-zero SSE hides this completely, so span, not
 * residual, is what has to gate the tier.
 */
export const MIN_DESCENT_DISTANCE_SPAN_RATIO = 4;

/** Minimum races before any descent-pacing tier is trusted -- same rationale
 * as MIN_INFORMATIVE_RACES for the tau/fInf fits. */
export const MIN_DESCENT_PACING_RACES = 3;

export interface DescentPacingFitResult {
  curve: DescentPacingCurve;
  /**
   * Which tier produced `curve`, mirroring fitTauFInfWithSupportGate's own
   * three-tier shape. "full" = all three parameters fit (needs both a
   * short and a long race, see MIN_DESCENT_DISTANCE_SPAN_RATIO); "fInfTau"
   * = f0 held at the default and only the asymptote/scale fit (the pool has
   * enough races but too narrow a distance span to identify the short-race
   * end); "defaults" = not enough to trust anything, `curve` is exactly the
   * default passed in and callers should NOT apply it as a fitted result.
   */
  tier: "full" | "fInfTau" | "defaults";
  raceCount: number;
  /** Longest race distance / shortest, the identifiability signal gating
   * the "full" tier. */
  distanceSpanRatio: number;
  /** Sum of squared residuals at `curve` -- diagnostic only, deliberately
   * NOT a gate (see MIN_DESCENT_DISTANCE_SPAN_RATIO's own doc on why a low
   * SSE is not evidence the fit generalizes). */
  sse: number;
}

/** Physically sane outer search bounds. A best fit sitting exactly ON one
 * of these is a boundary hit: the search wanted to keep going and was
 * clamped, so that parameter is pinned by the bound rather than identified
 * by the data -- the same failure fitTauFInfWithSupportGate guards with its
 * own hitSearchBoundary flags. Found in real data: this athlete's races
 * under 60km clear the distance-span gate (5.5x) yet still rail f0 to 1.3,
 * because no race short enough to constrain the short-race end exists in
 * that pool. */
const DESCENT_F0_BOUNDS: [number, number] = [0.9, 1.3];
const DESCENT_FINF_BOUNDS: [number, number] = [0.3, 0.9];
const DESCENT_TAU_BOUNDS: [number, number] = [5, 200];

function atBoundary(value: number, [lo, hi]: [number, number]): boolean {
  const tolerance = (hi - lo) * 1e-6;
  return value <= lo + tolerance || value >= hi - tolerance;
}

function descentSse(points: DescentPacingObservation[], curve: DescentPacingCurve): number {
  let sum = 0;
  for (const p of points) {
    const err = descentPacingMultiplier(p.totalDistanceKm, curve) - p.ratio;
    sum += err * err;
  }
  return sum;
}

/**
 * Coarse-then-refine grid search over the parameters `fitF0` selects.
 * Grid search rather than a closed-form or gradient method for the same
 * reason scripts/fitDescentPacingMultiplier.ts used one: the pool is a
 * handful of points, the surface is cheap to evaluate exhaustively, and a
 * grid is trivially verifiable against the printed residuals.
 */
function searchDescentCurve(
  points: DescentPacingObservation[],
  fallback: DescentPacingCurve,
  fitF0: boolean,
): { curve: DescentPacingCurve; sse: number } {
  const run = (
    f0Range: [number, number],
    fInfRange: [number, number],
    tauRange: [number, number],
    steps: number,
  ): { curve: DescentPacingCurve; sse: number } => {
    let best = { curve: fallback, sse: Infinity };
    for (let i = 0; i <= steps; i++) {
      const f0 = fitF0 ? f0Range[0] + ((f0Range[1] - f0Range[0]) * i) / steps : fallback.f0;
      for (let j = 0; j <= steps; j++) {
        const fInf = fInfRange[0] + ((fInfRange[1] - fInfRange[0]) * j) / steps;
        for (let k = 0; k <= steps; k++) {
          const tauKm = tauRange[0] + ((tauRange[1] - tauRange[0]) * k) / steps;
          const curve = { f0, fInf, tauKm };
          const sse = descentSse(points, curve);
          if (sse < best.sse) best = { curve, sse };
        }
      }
      if (!fitF0) break; // f0 held -- the outer loop has nothing to vary
    }
    return best;
  };

  const coarse = run(DESCENT_F0_BOUNDS, DESCENT_FINF_BOUNDS, DESCENT_TAU_BOUNDS, 40);
  return run(
    [Math.max(DESCENT_F0_BOUNDS[0], coarse.curve.f0 - 0.05), Math.min(DESCENT_F0_BOUNDS[1], coarse.curve.f0 + 0.05)],
    [Math.max(DESCENT_FINF_BOUNDS[0], coarse.curve.fInf - 0.05), Math.min(DESCENT_FINF_BOUNDS[1], coarse.curve.fInf + 0.05)],
    [Math.max(DESCENT_TAU_BOUNDS[0], coarse.curve.tauKm - 15), Math.min(DESCENT_TAU_BOUNDS[1], coarse.curve.tauKm + 15)],
    60,
  );
}

/**
 * Fits this athlete's own descent-pacing curve (minetti.ts's
 * DescentPacingCurve) from their confirmed races' actual descent speeds,
 * replacing DEFAULT_DESCENT_PACING_CURVE -- which is one specific athlete's
 * numbers and has no business being applied universally.
 *
 * Tiered exactly like fitTauFInfWithSupportGate, and for the same reason:
 * the three-parameter curve is genuinely unidentifiable on a narrow pool,
 * and a grid search will happily return a confident-looking near-zero-SSE
 * answer anyway (see MIN_DESCENT_DISTANCE_SPAN_RATIO's own doc for the real
 * case that motivated this). Callers should apply the result only when
 * `tier !== "defaults"`.
 */
export function fitDescentPacingCurveAcrossRaces(
  observations: DescentPacingObservation[],
  fallback: DescentPacingCurve = DEFAULT_DESCENT_PACING_CURVE,
  opts: { minRaces?: number; minDistanceSpanRatio?: number } = {},
): DescentPacingFitResult {
  const minRaces = opts.minRaces ?? MIN_DESCENT_PACING_RACES;
  const minSpan = opts.minDistanceSpanRatio ?? MIN_DESCENT_DISTANCE_SPAN_RATIO;
  const points = observations.filter((o) => o.totalDistanceKm > 0 && Number.isFinite(o.ratio));

  const distances = points.map((p) => p.totalDistanceKm);
  const distanceSpanRatio = distances.length > 0 ? Math.max(...distances) / Math.min(...distances) : 0;
  const base = { raceCount: points.length, distanceSpanRatio };

  if (points.length < minRaces) {
    return { curve: fallback, tier: "defaults", ...base, sse: descentSse(points, fallback) };
  }

  if (distanceSpanRatio >= minSpan) {
    const full = searchDescentCurve(points, fallback, true);
    // A wide distance span is necessary but not sufficient: f0 can still
    // rail to its search bound when the pool has no genuinely SHORT race
    // (see DESCENT_F0_BOUNDS' own doc for the real case). Demote to the
    // f0-held tier rather than shipping a pinned parameter as a fit.
    if (!atBoundary(full.curve.f0, DESCENT_F0_BOUNDS)) {
      return { curve: full.curve, tier: "full", ...base, sse: full.sse };
    }
  }

  // Either clustered too tightly in distance to identify the short-race
  // end, or f0 railed to its search boundary above -- either way, hold f0
  // at the fallback and fit only fInf/tau.
  const partial = searchDescentCurve(points, fallback, false);
  return { curve: partial.curve, tier: "fInfTau", ...base, sse: partial.sse };
}

/**
 * One race's contribution to the duration-ceiling fit: how long it took and
 * what fraction of VO2max was actually sustained over it (time-weighted).
 * The "fraction" here is measured against a FIXED sea-level maxAerobicPower
 * reference, not against the ceiling curve -- fitting the curve against a
 * quantity derived from the curve would be circular.
 */
export interface DurationCeilingObservation {
  durationMin: number;
  sustainedFraction: number;
  name?: string;
}

/** Plausibility bounds on the fitted exponent. A power law that decays far
 * faster or slower than this across a race library is far more likely to be
 * two anomalous races defining a hull than a real physiological curve. */
const DURATION_EXPONENT_BOUNDS: [number, number] = [0.03, 0.4];
/** Plausibility bounds on the 60-minute anchor, as a fraction of VO2max.
 * LT2 is conventionally about 60-minute power, so a sane athlete lands
 * roughly in the 0.6-0.95 band; the wider range here is deliberately
 * permissive, catching only nonsense. */
const DURATION_ANCHOR_BOUNDS: [number, number] = [0.3, 1];

/** Minimum confirmed races before any duration-ceiling tier is trusted. */
export const MIN_DURATION_CEILING_RACES = 3;
/** Longest/shortest race duration ratio needed to fit the EXPONENT as well
 * as the anchor. Same identifiability logic as the descent curve's own span
 * gate: two races an hour apart cannot tell you how the curve behaves from
 * 40 minutes to 24 hours, however well a 2-parameter fit appears to do. */
export const MIN_DURATION_CEILING_SPAN_RATIO = 4;

export interface DurationCeilingFitResult {
  fraction60Min: number;
  exponent: number;
  /** "full" = anchor and exponent both fit; "anchorOnly" = exponent held at
   * the fallback because the race durations are clustered too tightly to
   * identify it; "defaults" = nothing trustworthy, fallback returned
   * unchanged and callers must not apply it as a fit. */
  tier: "full" | "anchorOnly" | "defaults";
  raceCount: number;
  durationSpanRatio: number;
  /** The races the fitted curve touches exactly -- the hull points that
   * actually determined it. Worth surfacing: these are the performances the
   * athlete's whole ceiling is resting on. */
  bindingRaceNames: string[];
}

/**
 * Fits the tightest power-law ceiling that DOMINATES every confirmed race
 * -- the upper hull in log-log space, not a least-squares trend through the
 * middle of them.
 *
 * Dominance is the point. A ceiling is an upper bound, so a curve that any
 * completed race sits above is by definition wrong -- and that was the
 * original reported bug (a 42-minute race run at 86.1% of VO2max against a
 * ceiling of 81.4%). A least-squares fit reproduces it: fit through this
 * athlete's 8 races and Ecotrail lands 9.7% ABOVE its own ceiling.
 *
 * Deterministic and hand-tuning-free: with two parameters the tightest
 * dominating line touches exactly two races, so scanning all pairs and
 * keeping the lowest dominating one finds it exactly. O(n^2) on a handful
 * of races.
 */
export function fitDurationCeilingAcrossRaces(
  observations: DurationCeilingObservation[],
  fallback: { fraction60Min: number; exponent: number },
  opts: { minRaces?: number; minDurationSpanRatio?: number } = {},
): DurationCeilingFitResult {
  const minRaces = opts.minRaces ?? MIN_DURATION_CEILING_RACES;
  const minSpan = opts.minDurationSpanRatio ?? MIN_DURATION_CEILING_SPAN_RATIO;
  const points = observations.filter(
    (o) => o.durationMin > 0 && o.sustainedFraction > 0 && Number.isFinite(o.sustainedFraction),
  );

  const durations = points.map((p) => p.durationMin);
  const durationSpanRatio = durations.length > 0 ? Math.max(...durations) / Math.min(...durations) : 0;
  const base = { raceCount: points.length, durationSpanRatio };
  const asDefaults = (): DurationCeilingFitResult => ({
    ...fallback,
    tier: "defaults",
    ...base,
    bindingRaceNames: [],
  });

  if (points.length < minRaces) return asDefaults();

  const xs = points.map((p) => Math.log(p.durationMin));
  const ys = points.map((p) => Math.log(p.sustainedFraction));
  const dominatesAll = (a: number, b: number): boolean =>
    xs.every((x, i) => a + b * x >= ys[i] - 1e-9);
  const namesTouching = (a: number, b: number): string[] =>
    points
      .map((p, i) => ({ name: p.name ?? `race ${i + 1}`, touching: Math.abs(a + b * xs[i] - ys[i]) < 1e-6 }))
      .filter((r) => r.touching)
      .map((r) => r.name);

  if (durationSpanRatio >= minSpan) {
    // Tightest dominating line over all pairs -- "tightest" measured at the
    // 60-minute anchor, which is the curve's own reference point.
    let best: { a: number; b: number; anchor: number } | null = null;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (xs[i] === xs[j]) continue;
        const b = (ys[j] - ys[i]) / (xs[j] - xs[i]);
        const a = ys[i] - b * xs[i];
        if (!dominatesAll(a, b)) continue;
        const anchor = a + b * Math.log(60);
        if (!best || anchor < best.anchor) best = { a, b, anchor };
      }
    }
    if (best) {
      const exponent = -best.b;
      const fraction60Min = Math.exp(best.anchor);
      const sane =
        exponent >= DURATION_EXPONENT_BOUNDS[0] &&
        exponent <= DURATION_EXPONENT_BOUNDS[1] &&
        fraction60Min >= DURATION_ANCHOR_BOUNDS[0] &&
        fraction60Min <= DURATION_ANCHOR_BOUNDS[1];
      if (sane) {
        return {
          fraction60Min,
          exponent,
          tier: "full",
          ...base,
          bindingRaceNames: namesTouching(best.a, best.b),
        };
      }
    }
  }

  // Exponent held at the fallback; slide the anchor up until the curve
  // clears every race. Needs no duration span -- one race is enough to
  // raise an anchor, it just can't tell you the slope.
  let anchorLn = -Infinity;
  for (let i = 0; i < points.length; i++) {
    anchorLn = Math.max(anchorLn, ys[i] + fallback.exponent * (xs[i] - Math.log(60)));
  }
  const fraction60Min = Math.exp(anchorLn);
  if (fraction60Min < DURATION_ANCHOR_BOUNDS[0] || fraction60Min > DURATION_ANCHOR_BOUNDS[1]) return asDefaults();
  const aHeld = anchorLn + fallback.exponent * Math.log(60);
  return {
    fraction60Min,
    exponent: fallback.exponent,
    tier: "anchorOnly",
    ...base,
    bindingRaceNames: namesTouching(aHeld, -fallback.exponent),
  };
}

/** A race must exceed the capped aerobic curve by more than this relative
 * margin before it counts as evidence for W'/CP -- see its use below. */
const ANAEROBIC_IDENTIFIABILITY_TOLERANCE = 0.005;

export interface AnaerobicCapacityFitResult {
  anaerobicCapacityMin: number;
  /**
   * False when no race in the library actually constrains W'/CP, in which
   * case anaerobicCapacityMin is the unchanged fallback and callers must
   * not treat it as fitted. This is the normal outcome for an athlete
   * whose shortest race is long enough that the aerobic curve alone already
   * covers it -- W'/CP only becomes visible once the VO2max cap binds,
   * which is roughly the sub-15-minute range.
   */
  identifiable: boolean;
  /** Shortest race duration in the library, minutes -- what the message
   * "confirm a shorter race to pin this down" is based on. */
  shortestRaceMin: number | null;
}

/**
 * Fits the critical-power capacity term W'/CP (ceiling.ts's
 * anaerobicCapacityMultiplier) as the smallest value making the FULL
 * ceiling -- aerobic curve, VO2max-capped, times the anaerobic
 * multiplier -- dominate every race.
 *
 * Usually returns identifiable: false, and that is the correct answer, not
 * a failure: the aerobic power law is itself fit as an envelope over the
 * same races, so it already covers them all and leaves nothing for W'/CP to
 * explain. The term only becomes identifiable from a race short enough that
 * the VO2max cap binds and the aerobic curve alone therefore CAN'T reach
 * the observed effort. Reporting that honestly beats fitting 0 and silently
 * deleting the short-race boost from an athlete's future 5k plan.
 */
export function fitAnaerobicCapacityMin(
  observations: DurationCeilingObservation[],
  curve: { fraction60Min: number; exponent: number },
  fallbackAnaerobicCapacityMin: number,
): AnaerobicCapacityFitResult {
  const points = observations.filter((o) => o.durationMin > 0 && o.sustainedFraction > 0);
  if (points.length === 0) {
    return { anaerobicCapacityMin: fallbackAnaerobicCapacityMin, identifiable: false, shortestRaceMin: null };
  }
  const shortestRaceMin = Math.min(...points.map((p) => p.durationMin));

  let required = 0;
  for (const p of points) {
    const aerobic = Math.min(curve.fraction60Min * Math.pow(p.durationMin / 60, -curve.exponent), 1);
    // Relative tolerance, not a bare >=: the aerobic curve is fit as an
    // envelope touching its hull races EXACTLY, so rounding alone (stored
    // params carry a few digits; the fit does not) can leave a hull race a
    // hair above its own curve. Without this, that noise "identifies"
    // W'/CP at some meaningless near-zero value.
    if (aerobic >= p.sustainedFraction * (1 - ANAEROBIC_IDENTIFIABILITY_TOLERANCE)) continue;
    // Need (1 + k/t) * aerobic >= actual, i.e. k >= t * (actual/aerobic - 1).
    required = Math.max(required, Math.max(p.durationMin, 2) * (p.sustainedFraction / aerobic - 1));
  }

  if (required <= 0) {
    return { anaerobicCapacityMin: fallbackAnaerobicCapacityMin, identifiable: false, shortestRaceMin };
  }
  return { anaerobicCapacityMin: required, identifiable: true, shortestRaceMin };
}

/**
 * One grade band's demonstrated descending speed, pooled across every run
 * that contributed distance to it.
 */
export interface DescentCapObservation {
  /** Band midpoint gradient (negative). */
  gradient: number;
  /** Distance-weighted high percentile of recorded speed in this band. */
  speedMs: number;
  /** Total distance behind this band, in metres -- its weight and support. */
  distanceM: number;
}

/** Band width for pooling descent segments by gradient. */
export const DESCENT_CAP_BAND_WIDTH = 0.02;
/**
 * A band below this much distance is dropped. At the pipeline's 25m
 * segments this is ~80 samples, so DESCENT_CAP_PERCENTILE sits a few
 * samples in from the top rather than ON the single fastest one.
 *
 * Set from a real failure: at 300m a band held ~12 segments, its p95 was
 * simply its maximum, and the handful of near-vertical bands an elevation
 * trace produces (0.3-0.5km each, with "demonstrated" speeds like 4:02/km
 * at -45%) dragged the envelope's steep anchor up until the fitted cap was
 * FLAT -- claiming a -45% slope is as fast as a -10% one.
 */
export const MIN_DESCENT_CAP_BAND_DISTANCE_M = 2000;
/**
 * Percentile taken within each band, not the maximum. The quantity wanted
 * is "the fastest this athlete demonstrably controls at this gradient", and
 * the maximum of a few thousand 25m segments is a GPS spike every time.
 * High enough to sit in the genuinely-descending-hard tail (most descent
 * segments in any race are paced, not maximal, so a median would measure
 * pacing rather than capability), low enough to shed outliers.
 */
export const DESCENT_CAP_PERCENTILE = 0.95;
/** Anything faster than this on a descent is a GPS artifact, not a run --
 * 8 m/s is 2:05/km, quicker than a world-record marathon on the flat. */
const DESCENT_CAP_IMPLAUSIBLE_SPEED_MS = 8;
/** Total descent distance (below the ramp-start grade) before any tier is
 * trusted at all. */
export const MIN_DESCENT_CAP_DISTANCE_M = 3000;
/** Distance at or below STEEP_PIVOT before the clamp anchor is considered
 * identifiable -- without it the steep end of the line is extrapolation
 * off the shallow end, which is exactly how the default got its shape. */
export const MIN_STEEP_DESCENT_DISTANCE_M = 800;
const STEEP_PIVOT_GRADE = -0.2;
const RAMP_START_GRADE = -0.04;

/** Distance-weighted percentile of a set of (speed, weight) samples. */
function weightedPercentile(samples: { speedMs: number; weightM: number }[], p: number): number {
  const sorted = [...samples].sort((a, b) => a.speedMs - b.speedMs);
  const total = sorted.reduce((acc, s) => acc + s.weightM, 0);
  if (total <= 0) return 0;
  let seen = 0;
  for (const s of sorted) {
    seen += s.weightM;
    if (seen >= p * total) return s.speedMs;
  }
  return sorted[sorted.length - 1].speedMs;
}

/**
 * Pools every run's descent segments into grade bands and reports the
 * demonstrated speed in each.
 *
 * Deliberately fed the WIDE run pool, not just confirmed races -- unlike
 * fitDescentPacingCurveAcrossRaces, which measures a race-day pacing
 * CHOICE and would be diluted by training runs. This measures a physical
 * capability, so a hard training descent is evidence of it just as much as
 * a race one, and taking a high percentile means the extra easy-jogging
 * distance costs nothing while the extra fast tail helps.
 */
export function buildDescentCapObservations(runs: CourseSegment[][]): DescentCapObservation[] {
  const bands = new Map<number, { speedMs: number; weightM: number }[]>();
  for (const segments of runs) {
    for (const seg of segments) {
      // Below the clamp the cost/cap model holds everything constant, so
      // such a band cannot inform the curve -- and at those gradients the
      // smoothed elevation trace is mostly noise anyway (a sustained -60%
      // is a cliff, not a trail).
      if (seg.paused || seg.gradient >= RAMP_START_GRADE || seg.gradient < -GRADE_CLAMP) continue;
      if (seg.dtS === null || seg.dtS <= 0 || seg.distance3D <= 0) continue;
      const speedMs = seg.distance3D / seg.dtS;
      if (!(speedMs > 0) || speedMs > DESCENT_CAP_IMPLAUSIBLE_SPEED_MS) continue;
      const band = Math.floor(seg.gradient / DESCENT_CAP_BAND_WIDTH) * DESCENT_CAP_BAND_WIDTH;
      const list = bands.get(band);
      if (list) list.push({ speedMs, weightM: seg.distance3D });
      else bands.set(band, [{ speedMs, weightM: seg.distance3D }]);
    }
  }
  const out: DescentCapObservation[] = [];
  for (const [band, samples] of bands) {
    const distanceM = samples.reduce((a, s) => a + s.weightM, 0);
    if (distanceM < MIN_DESCENT_CAP_BAND_DISTANCE_M) continue;
    out.push({
      gradient: band + DESCENT_CAP_BAND_WIDTH / 2,
      speedMs: weightedPercentile(samples, DESCENT_CAP_PERCENTILE),
      distanceM,
    });
  }
  return out.sort((a, b) => b.gradient - a.gradient);
}

export interface DescentCapFitResult {
  curve: DescentCapCurve;
  /** "full" = both anchors fit. "onsetOnly" = not enough steep descent to
   * place the clamp anchor, so it is carried at the fallback's own
   * clamp/onset ratio rather than invented. "defaults" = untouched. */
  tier: "full" | "onsetOnly" | "defaults";
  /** Bands that actually constrained the result (the curve touches them). */
  bindingGradients: number[];
  totalDescentM: number;
  steepDescentM: number;
  bandCount: number;
}

const ONSET_BOUNDS: [number, number] = [1.2, 7];
const CLAMP_BOUNDS: [number, number] = [0.3, 5];
/** Slack when testing whether the curve clears a band, in m/s. Bands are
 * percentiles of noisy GPS, so demanding exact domination would let one
 * band's noise set the whole curve. */
const DESCENT_CAP_TOLERANCE_MS = 0.05;

/**
 * Fits the per-athlete descent cap as the TIGHTEST curve that still allows
 * every grade band's demonstrated speed.
 *
 * An envelope rather than a least-squares fit, for the same reason
 * fitDurationCeilingAcrossRaces is one: this is a ceiling, and a ceiling
 * that sits below something the athlete has already done is wrong by
 * definition, however small its residual. Least squares would happily
 * split the difference and keep forbidding the fast bands.
 */
export function fitDescentCapCurve(
  observations: DescentCapObservation[],
  fallback: DescentCapCurve = DEFAULT_DESCENT_CAP_CURVE,
): DescentCapFitResult {
  const totalDescentM = observations.reduce((a, o) => a + o.distanceM, 0);
  const steepDescentM = observations
    .filter((o) => o.gradient <= STEEP_PIVOT_GRADE)
    .reduce((a, o) => a + o.distanceM, 0);
  const base = { bindingGradients: [] as number[], totalDescentM, steepDescentM, bandCount: observations.length };

  if (observations.length < 2 || totalDescentM < MIN_DESCENT_CAP_DISTANCE_M) {
    return { curve: fallback, tier: "defaults", ...base };
  }
  const steepIdentifiable = steepDescentM >= MIN_STEEP_DESCENT_DISTANCE_M;
  // With no steep support the clamp anchor cannot be measured, so hold the
  // fallback's SHAPE (its clamp/onset ratio) and let the fit move only the
  // level. Inventing a clamp off shallow data is how the default got a
  // steep end nobody had measured.
  const ratio = fallback.onsetSpeedMs > 0 ? fallback.clampSpeedMs / fallback.onsetSpeedMs : 0.36;

  let best: { curve: DescentCapCurve; excess: number } | null = null;
  const STEPS = 120;
  for (let a = 0; a <= STEPS; a++) {
    const onsetSpeedMs = ONSET_BOUNDS[0] + ((ONSET_BOUNDS[1] - ONSET_BOUNDS[0]) * a) / STEPS;
    const clampCandidates = steepIdentifiable
      ? Array.from({ length: STEPS + 1 }, (_, b) => CLAMP_BOUNDS[0] + ((CLAMP_BOUNDS[1] - CLAMP_BOUNDS[0]) * b) / STEPS)
      : [onsetSpeedMs * ratio];
    for (const clampSpeedMs of clampCandidates) {
      // A cap that rises as the slope steepens is not a cap.
      if (clampSpeedMs > onsetSpeedMs) continue;
      const curve = { onsetSpeedMs, clampSpeedMs };
      let excess = 0;
      let ok = true;
      for (const o of observations) {
        const allowed = gradeOnlyMaxDescentSpeedMs(o.gradient, curve);
        if (!Number.isFinite(allowed)) continue;
        if (allowed < o.speedMs - DESCENT_CAP_TOLERANCE_MS) { ok = false; break; }
        excess += (allowed - o.speedMs) * o.distanceM;
      }
      if (!ok) continue;
      if (best === null || excess < best.excess) best = { curve, excess };
    }
  }
  if (best === null) return { curve: fallback, tier: "defaults", ...base };

  const bindingGradients = observations
    .filter((o) => {
      const allowed = gradeOnlyMaxDescentSpeedMs(o.gradient, best!.curve);
      return Number.isFinite(allowed) && allowed - o.speedMs < 3 * DESCENT_CAP_TOLERANCE_MS;
    })
    .map((o) => o.gradient);

  return {
    curve: best.curve,
    tier: steepIdentifiable ? "full" : "onsetOnly",
    ...base,
    bindingGradients,
  };
}
