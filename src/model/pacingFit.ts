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

import type { CourseSegment } from "../gpx/pipeline";
import type { AnalysisSegmentResult } from "./analysis";
import { type CeilingParams, ceilingPower } from "./ceiling";
import { descentStepForSegment } from "./descentImpact";
import { hasSurfaceData, surfaceStepForSegment } from "./surfaceExposure";

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
   * Cumulative unpaved/technical-trail distance accumulated *before* this
   * segment, meters -- same "so far" convention as the descent fields
   * above. Undefined for a whole race means no surface data was ever
   * attached to it (see surfaceExposure.ts's attachSurfaceData) -- distinct
   * from a genuinely all-paved race, where every point still gets 0.
   * fitSurfaceDriftPerUnpavedUnit/fitSurfaceDriftAcrossRaces skip races
   * with no surface data rather than treating them as 0% unpaved.
   */
  cumulativeUnpavedM?: number;
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

/** Running per-segment unpaved-distance sums, same "start of each
 * courseSegments index" convention as cumulativeDescentBeforeEachSegment.
 * Returns all-undefined when the course has no surface data at all (see
 * surfaceExposure.ts's hasSurfaceData) rather than all-zero, so a race that
 * was never surface-classified isn't mistaken for one that's genuinely
 * 100% paved. */
function cumulativeUnpavedBeforeEachSegment(courseSegments: CourseSegment[]): (number | undefined)[] {
  if (!hasSurfaceData(courseSegments)) return courseSegments.map(() => undefined);
  const result: number[] = [];
  let m = 0;
  for (const seg of courseSegments) {
    result.push(m);
    m += surfaceStepForSegment(seg).unpavedM;
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
  const cumulativeUnpaved = cumulativeUnpavedBeforeEachSegment(courseSegments);
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
      cumulativeUnpavedM: cumulativeUnpaved[s.index],
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
 *
 * unpavedExposureSelector is the same idea, one level over: optional and
 * omitted by every caller except fitSurfaceDriftPerUnpavedUnit below, reads
 * cumulativeUnpavedM off each point and passes it through to ceilingPower
 * as unpavedExposureM for the surface-based drift term.
 */
export function computeEffortTrend(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  descentExposureSelector?: (p: EffortTrendPoint) => number,
  unpavedExposureSelector?: (p: EffortTrendPoint) => number,
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
        ...(unpavedExposureSelector ? { unpavedExposureM: unpavedExposureSelector(p) } : {}),
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
export function computeFadeTrend(points: EffortTrendPoint[], ceilingParams: CeilingParams): TrendFit | null {
  if (points.length === 0) return computeEffortTrend(points, ceilingParams);

  // Plain array of bins (points are already time-ordered, so this is just
  // an offset lookup) instead of a Map, and sort each bin's array in place
  // instead of copying it first -- this runs inside tau/fInf grid searches,
  // called for many candidate values per race per fit, so per-call overhead
  // compounds quickly.
  const binHours = PEAK_TREND_BIN_MINUTES / 60;
  const firstBin = Math.floor(points[0].tHours / binHours);
  const lastBin = Math.floor(points[points.length - 1].tHours / binHours);
  const bins: number[][] = Array.from({ length: lastBin - firstBin + 1 }, () => []);
  for (const p of points) {
    const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
    if (ceiling <= 0) continue;
    bins[Math.floor(p.tHours / binHours) - firstBin].push(p.grossPowerWPerKg / ceiling);
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
  if (xs.length < MIN_PEAK_BINS) return computeEffortTrend(points, ceilingParams);

  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  if (sxx <= 0) return computeEffortTrend(points, ceilingParams);
  return { slopePerHour: sxy / sxx };
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

export interface TauFitResult {
  tauMin: number;
  trendAtCurrentPctPerHour: number;
  trendAtFitPctPerHour: number;
  /** Set when the fit landed at the edge of its search range -- the true
   * value may lie beyond it in that direction (a bound, not a precise
   * estimate). Null when the fit found an interior optimum. */
  hitSearchBoundary: "lower" | "upper" | null;
}

/**
 * Searches tau -- holding f0/fInf/lt2/drift at whatever's currently
 * configured -- for the value whose fade shape best matches how this run's
 * actual effort held up relative to the ceiling (i.e. minimizes the
 * dt-weighted slope of effort vs. elapsed time). Coarse-then-fine grid
 * search, in the same spirit as the solver's bisection: cheap, explainable,
 * no dependency.
 *
 * The default range is scaled to the run's own duration, not a fixed
 * constant -- both tau extremes are degenerate: a tau much shorter than the
 * race saturates the ceiling to a flat fInf within the first hour or two
 * (so it "flattens" the slope for the remaining several hours by making the
 * ceiling stop moving at all, not by matching any real fade shape), and a
 * tau much longer than the race keeps the raw fraction above LT2 the whole
 * time, pinning the ceiling flat at LT2 instead. Both produce a spuriously
 * good (near-zero) slope without meaning what it looks like it means, so
 * candidates are kept within a factor of the observed duration, which
 * structurally forces the transition to actually fall inside the window.
 * The upper end is also floored at ABSOLUTE_MAX_TAU_MIN purely as a numerical
 * safety net (not a physiological limit) -- it's set high enough that it
 * shouldn't bind for any real race, multi-day events included.
 */
const ABSOLUTE_MAX_TAU_MIN = 5000; // ~83 hours

/**
 * Tau enters the ceiling curve as exp(-t/tau) -- equally-spaced *ratios*
 * change the curve's shape by equal amounts, not equally-spaced absolute
 * values, so a search grid should be log-spaced in tau, not linear. This
 * matters concretely with computeFadeTrend: pooling races of very different
 * durations can stretch a tau search range across two-plus orders of
 * magnitude (a short training run's range floor vs. a 24h+ ultra's range
 * ceiling), and a fixed number of *linearly* spaced points sparsens
 * enormously at the low end where the real signal actually sits -- confirmed
 * empirically: a real pooled fit landed on tau=2614min sitting on a wide,
 * nearly-flat plateau (squared-slope basically unchanged from 750 to 5000)
 * because the linear coarse grid's ~90min step stepped clean over a real,
 * sharp minimum near tau=124min without ever sampling close enough to see
 * it. Log spacing keeps points dense right where tau is small (where the
 * curve moves fastest) and only sparse out on the flat, already-saturated
 * end, at the same total candidate count.
 */
function searchTauLogSpaced(lo: number, hi: number, objective: (tau: number) => number): number {
  const evaluate = (count: number, from: number, to: number) => {
    const logFrom = Math.log(Math.max(from, 1));
    const logTo = Math.log(Math.max(to, from + 1));
    let bestTau = from;
    let bestScore = Infinity;
    let bestIndex = 0;
    const candidates: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const tau = Math.exp(logFrom + t * (logTo - logFrom));
      candidates.push(tau);
      const score = objective(tau);
      if (score < bestScore) {
        bestScore = score;
        bestTau = tau;
        bestIndex = i;
      }
    }
    return { bestTau, bestIndex, candidates };
  };

  const coarse = evaluate(40, lo, hi);
  // Refine within the immediate log-spaced neighbors of the coarse winner,
  // not a fixed linear window -- keeps the same "equal ratios" resolution
  // advantage in the fine pass.
  const fineLo = coarse.candidates[Math.max(0, coarse.bestIndex - 1)];
  const fineHi = coarse.candidates[Math.min(coarse.candidates.length - 1, coarse.bestIndex + 1)];
  const fine = evaluate(20, fineLo, fineHi);
  return fine.bestTau;
}

export function fitTauMinutes(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  range?: [number, number],
): TauFitResult | null {
  const trimmed = trimForPacingFit(points);
  if (trimmed.length < MIN_FIT_POINTS) return null;

  const currentTrend = computeFadeTrend(trimmed, ceilingParams);
  if (!currentTrend) return null;

  const totalMin = trimmed[trimmed.length - 1].tHours * 60;
  const resolvedRange: [number, number] = range ?? [
    Math.max(20, totalMin * 0.3),
    Math.min(ABSOLUTE_MAX_TAU_MIN, Math.max(totalMin * 2.5, totalMin * 0.3 + 40)),
  ];

  const objective = (tau: number) => {
    const trend = computeFadeTrend(trimmed, { ...ceilingParams, tauMin: tau });
    return trend ? Math.abs(trend.slopePerHour) : Infinity;
  };

  const [lo, hi] = resolvedRange;
  const fine = searchTauLogSpaced(lo, hi, objective);

  const fittedTrend = computeFadeTrend(trimmed, { ...ceilingParams, tauMin: fine });
  if (!fittedTrend) return null;

  const tauMin = Math.round(fine);
  const hitSearchBoundary = tauMin <= lo + 1 ? "lower" : tauMin >= hi - 1 ? "upper" : null;
  return {
    tauMin,
    trendAtCurrentPctPerHour: currentTrend.slopePerHour * 100,
    trendAtFitPctPerHour: fittedTrend.slopePerHour * 100,
    hitSearchBoundary,
  };
}

/** Below this fractional drop in the modeled ceiling across a race's own
 * trimmed window (at the fitted tau), the race is treated as having had no
 * say in the result -- see MultiRaceTauFitResult.perRace's doc. Chosen from
 * a synthetic short/long mix (0% for races too short to leave the LT2 cap
 * vs. 5-11% for ones that do) and a clean two-race case (28-32%, nowhere
 * near the cutoff) -- see pacingFit.test.ts. */
const MIN_CEILING_DROP_FRACTION = 0.03;

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

export interface MultiRaceTauFitResult {
  tauMin: number;
  perRace: {
    trendAtCurrentPctPerHour: number;
    trendAtFitPctPerHour: number;
    /**
     * True if the modeled ceiling barely moves across this race's own
     * trimmed window at the fitted tau -- i.e. it's sitting flat against the
     * LT2 cap (tau large relative to the race) or flat at the fInf floor
     * (tau small relative to the race) for its entire duration. Either way,
     * tau has no effect on this race's ceiling shape at the reported value,
     * so it had no say in *where* the fit landed even though its own
     * trendAtFitPctPerHour above is a real number -- pooling it in just
     * dilutes the result with a race that structurally can't inform tau.
     * Short runs are the common case in practice.
     */
    unresponsive: boolean;
  }[];
  /** Count of perRace entries with unresponsive === false -- see
   * MIN_INFORMATIVE_RACES above for why this matters beyond just perRace
   * detail. */
  informativeRaceCount: number;
  hitSearchBoundary: "lower" | "upper" | null;
}

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
export function fitTauAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: FitTauAcrossRacesOptions = {},
): MultiRaceTauFitResult | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const trimmedWithWeight = races
    .map((r, i) => {
      const date = opts.raceDates?.[i] ?? null;
      return {
        points: trimForPacingFit(r),
        recencyWeight: date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1,
      };
    })
    .filter((r) => r.points.length >= MIN_FIT_POINTS);
  if (trimmedWithWeight.length === 0) return null;

  const trimmed = trimmedWithWeight.map((r) => r.points);
  const recencyWeights = trimmedWithWeight.map((r) => r.recencyWeight);

  const currentTrends = trimmed.map((r) => computeFadeTrend(r, ceilingParams));
  if (currentTrends.some((t) => !t)) return null;

  const totalMinPerRace = trimmed.map((r) => r[r.length - 1].tHours * 60);
  const lo = Math.max(20, Math.min(...totalMinPerRace) * 0.3);
  const hi = Math.min(ABSOLUTE_MAX_TAU_MIN, Math.max(...totalMinPerRace) * 2.5);

  const pooledSquaredSlope = (tau: number) => {
    let sum = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const trend = computeFadeTrend(trimmed[i], { ...ceilingParams, tauMin: tau });
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  const tauMin = Math.round(searchTauLogSpaced(lo, hi, pooledSquaredSlope));
  const fittedTrends = trimmed.map((r) => computeFadeTrend(r, { ...ceilingParams, tauMin }));
  if (fittedTrends.some((t) => !t)) return null;

  const hitSearchBoundary = tauMin <= lo + 1 ? "lower" : tauMin >= hi - 1 ? "upper" : null;

  // Measures the saturation mechanism directly, at the fitted tau, on each
  // race's own window -- rather than inferring it from how much the slope
  // moves (which can look "responsive" far from tauMin while still being
  // completely flat right where the search landed).
  const ceilingDropFraction = (race: EffortTrendPoint[]) => {
    const start = race[0];
    const end = race[race.length - 1];
    const ceilStart = ceilingPower({ tMin: start.tHours * 60, altitudeM: start.altitudeM, elapsedHours: start.tHours }, { ...ceilingParams, tauMin });
    const ceilEnd = ceilingPower({ tMin: end.tHours * 60, altitudeM: end.altitudeM, elapsedHours: end.tHours }, { ...ceilingParams, tauMin });
    return ceilStart > 0 ? (ceilStart - ceilEnd) / ceilStart : 0;
  };

  const perRace = currentTrends.map((current, i) => ({
    trendAtCurrentPctPerHour: current!.slopePerHour * 100,
    trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
    unresponsive: ceilingDropFraction(trimmed[i]) < MIN_CEILING_DROP_FRACTION,
  }));

  return {
    tauMin,
    perRace,
    informativeRaceCount: perRace.filter((r) => !r.unresponsive).length,
    hitSearchBoundary,
  };
}

/** Mirrors ceiling.ts's own DEFAULTS.lt2Fraction -- not exported from there,
 * so restated here for the fInf search range below. */
const DEFAULT_LT2_FRACTION = 0.85;
/** fInf is the *more* fatigued, asymptotic fraction -- it should sit below
 * the LT2-anchored plateau, not at or above it. Practically, letting the
 * search reach lt2Fraction also reopens a version of the scale-invariance
 * problem fixing f0 was meant to close: sustainableFraction's own
 * Math.min(fraction, lt2Fraction) cap makes any fInf >= lt2Fraction behave
 * identically (flat at the cap), so that region is unidentifiable, not just
 * physiologically implausible. */
const MIN_FINF = 0.1;
const FINF_UPPER_MARGIN = 0.02;

export interface FInfTauFitResult {
  fInf: number;
  tauMin: number;
  /** Longest / shortest trimmed race duration among the races used in this
   * fit -- operationalizes PLAN.md §11's "~2x+ duration range" precondition
   * for separating fInf from tau as a visible number rather than a
   * guideline. Below ~2, the fit still runs (validated with a synthetic
   * recovery test -- it degrades gracefully, not catastrophically) but is
   * markedly less precise. */
  durationDiversityRatio: number;
  perRace: {
    trendAtCurrentPctPerHour: number;
    trendAtFitPctPerHour: number;
    unresponsive: boolean;
  }[];
  /** See MIN_INFORMATIVE_RACES's doc above -- count of perRace entries with
   * unresponsive === false. */
  informativeRaceCount: number;
  hitSearchBoundary: { fInf: "lower" | "upper" | null; tau: "lower" | "upper" | null };
}

/**
 * Jointly fits (fInf, tau) across several races -- f0 and vo2MaxMlPerKgPerMin
 * are held fixed at whatever's in `ceilingParams`, exactly as
 * fitTauAcrossRaces already does for f0/fInf today. That's not an arbitrary
 * restriction: within-race-slope objectives are scale-invariant under a
 * *joint* rescaling of f0 and fInf (any f0=fInf flat ceiling of any level
 * zeroes every race's slope), which is what made a 3-parameter joint fit
 * ill-posed. Holding f0 fixed breaks that specific degeneracy -- rescaling
 * fInf alone, with f0 pinned, no longer rescales the whole curve by a
 * matching constant. Validated with a synthetic recovery test (known
 * f0/fInf/tau, races built to follow that ceiling exactly) rather than
 * trusted from derivation alone -- see PLAN.md §11 for the numbers and the
 * framing caveat: this makes the *search* well-posed, it does not give fInf
 * independent empirical grounding. fInf comes out relative to whatever f0
 * and vo2MaxMlPerKgPerMin currently are, and absorbs error in both -- three
 * coupled quantities, not an independently-verified one.
 *
 * Meaningfully lower-confidence than fitTauAcrossRaces: real precision
 * depends on durationDiversityRatio, which most libraries won't have yet.
 * Report it, don't hide it -- callers should surface it plainly rather than
 * presenting fInf as a settled number regardless of that ratio.
 */
export function fitFInfAndTauAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: FitTauAcrossRacesOptions = {},
): FInfTauFitResult | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const trimmedWithWeight = races
    .map((r, i) => {
      const date = opts.raceDates?.[i] ?? null;
      return {
        points: trimForPacingFit(r),
        recencyWeight: date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1,
      };
    })
    .filter((r) => r.points.length >= MIN_FIT_POINTS);
  if (trimmedWithWeight.length === 0) return null;

  const trimmed = trimmedWithWeight.map((r) => r.points);
  const recencyWeights = trimmedWithWeight.map((r) => r.recencyWeight);

  const currentTrends = trimmed.map((r) => computeFadeTrend(r, ceilingParams));
  if (currentTrends.some((t) => !t)) return null;

  const totalMinPerRace = trimmed.map((r) => r[r.length - 1].tHours * 60);
  const tauLo = Math.max(20, Math.min(...totalMinPerRace) * 0.3);
  const tauHi = Math.min(ABSOLUTE_MAX_TAU_MIN, Math.max(...totalMinPerRace) * 2.5);

  const lt2Fraction = ceilingParams.lt2Fraction ?? DEFAULT_LT2_FRACTION;
  const fInfLo = MIN_FINF;
  const fInfHi = Math.max(fInfLo + 0.01, lt2Fraction - FINF_UPPER_MARGIN);

  const pooledSquaredSlope = (fInf: number, tau: number) => {
    let sum = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const trend = computeFadeTrend(trimmed[i], { ...ceilingParams, fInf, tauMin: tau });
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  // For each candidate fInf, searches tau log-spaced (see searchTauLogSpaced's
  // doc -- the same wide-range-hides-a-narrow-minimum failure mode applies
  // here across the tau axis regardless of which fInf is being tried) rather
  // than restricting tau's own window between passes the way the fInf axis
  // still does -- tau needs the full range checked at every fInf, since a
  // fine pass's narrowed tau window carried over from a different fInf's
  // optimum could just as easily miss its own true minimum.
  const searchAtEachFInf = (fLo: number, fHi: number, count: number) => {
    let best = { fInf: fLo, tau: tauLo, score: Infinity };
    const fStep = count > 1 ? (fHi - fLo) / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      const fInf = fLo + i * fStep;
      const tau = searchTauLogSpaced(tauLo, tauHi, (t) => pooledSquaredSlope(fInf, t));
      const score = pooledSquaredSlope(fInf, tau);
      if (score < best.score) best = { fInf, tau, score };
    }
    return best;
  };

  const coarseFStep = Math.max(0.01, (fInfHi - fInfLo) / 25);
  const coarse = searchAtEachFInf(fInfLo, fInfHi, 26);
  const fine = searchAtEachFInf(Math.max(fInfLo, coarse.fInf - coarseFStep), Math.min(fInfHi, coarse.fInf + coarseFStep), 11);

  const fInf = Math.round(fine.fInf * 1000) / 1000;
  const tauMin = Math.round(fine.tau);

  const fittedTrends = trimmed.map((r) => computeFadeTrend(r, { ...ceilingParams, fInf, tauMin }));
  if (fittedTrends.some((t) => !t)) return null;

  // Same saturation-at-the-fitted-params measurement fitTauAcrossRaces uses
  // for its own unresponsive flag, just at (fInf, tau) instead of tau alone.
  const ceilingDropFraction = (race: EffortTrendPoint[]) => {
    const start = race[0];
    const end = race[race.length - 1];
    const params = { ...ceilingParams, fInf, tauMin };
    const ceilStart = ceilingPower({ tMin: start.tHours * 60, altitudeM: start.altitudeM, elapsedHours: start.tHours }, params);
    const ceilEnd = ceilingPower({ tMin: end.tHours * 60, altitudeM: end.altitudeM, elapsedHours: end.tHours }, params);
    return ceilStart > 0 ? (ceilStart - ceilEnd) / ceilStart : 0;
  };

  const perRace = currentTrends.map((current, i) => ({
    trendAtCurrentPctPerHour: current!.slopePerHour * 100,
    trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
    unresponsive: ceilingDropFraction(trimmed[i]) < MIN_CEILING_DROP_FRACTION,
  }));

  return {
    fInf,
    tauMin,
    durationDiversityRatio: Math.max(...totalMinPerRace) / Math.min(...totalMinPerRace),
    perRace,
    informativeRaceCount: perRace.filter((r) => !r.unresponsive).length,
    hitSearchBoundary: {
      fInf: fInf <= fInfLo + 0.005 ? "lower" : fInf >= fInfHi - 0.005 ? "upper" : null,
      tau: tauMin <= tauLo + 1 ? "lower" : tauMin >= tauHi - 1 ? "upper" : null,
    },
  };
}

/** PLAN.md §11's "~2x+ duration range" precondition for a jointly-fit fInf
 * to mean anything more than an unconstrained absorbing parameter. */
export const MIN_DURATION_DIVERSITY_RATIO = 2;

export interface SafeFitResult {
  /** fInf/tauMin merged in from whichever tier was actually trusted;
   * unchanged from the input ceilingParams when tier is "defaults". */
  ceilingParams: CeilingParams;
  /**
   * Which of the three tiers below produced ceilingParams -- "joint" means
   * fitFInfAndTauAcrossRaces was trustworthy on its own terms
   * (durationDiversityRatio, informativeRaceCount, no boundary hits);
   * "tauOnly" means it fell back to fitTauAcrossRaces (fInf held at
   * whatever was already configured); "defaults" means neither fit had
   * enough informative races to trust at all, so the input ceilingParams
   * pass through completely untouched.
   */
  tier: "joint" | "tauOnly" | "defaults";
  fInfFit: FInfTauFitResult | null;
  tauFit: MultiRaceTauFitResult | null;
}

/**
 * Three-tier fallback shared by any caller that needs a trustworthy
 * (fInf, tau) from a set of races without blindly accepting whatever a fit
 * returns: joint fInf/tau fit -> tau-only fit -> hold the input
 * ceilingParams untouched. Each tier requires at least
 * MIN_INFORMATIVE_RACES races that actually constrain the parameter(s)
 * being fit (see MIN_INFORMATIVE_RACES's own doc) -- a fit "pooled across N
 * races" where only one of them is actually informative is really just
 * that one race's idiosyncratic pacing, not a genuine consensus, and
 * shouldn't be trusted just because it ran without error. Originally
 * inline in scripts/backtestFinishTime.ts; promoted here once
 * finishTimeRange.ts needed the identical logic for both a point estimate
 * and (in a cheaper, tau-only form) many bootstrap resamples.
 */
export function fitTauFInfWithSupportGate(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: FitTauAcrossRacesOptions & { minDurationDiversityRatio?: number } = {},
): SafeFitResult {
  const minDurationDiversityRatio = opts.minDurationDiversityRatio ?? MIN_DURATION_DIVERSITY_RATIO;
  const fInfFit = fitFInfAndTauAcrossRaces(races, ceilingParams, opts);
  const tauFit = fitTauAcrossRaces(races, ceilingParams, opts);

  if (
    fInfFit &&
    fInfFit.durationDiversityRatio >= minDurationDiversityRatio &&
    fInfFit.informativeRaceCount >= MIN_INFORMATIVE_RACES &&
    !fInfFit.hitSearchBoundary.fInf &&
    !fInfFit.hitSearchBoundary.tau
  ) {
    return {
      ceilingParams: { ...ceilingParams, fInf: fInfFit.fInf, tauMin: fInfFit.tauMin },
      tier: "joint",
      fInfFit,
      tauFit,
    };
  }

  if (tauFit && tauFit.informativeRaceCount >= MIN_INFORMATIVE_RACES && !tauFit.hitSearchBoundary) {
    return {
      ceilingParams: { ...ceilingParams, tauMin: tauFit.tauMin },
      tier: "tauOnly",
      fInfFit,
      tauFit,
    };
  }

  return { ceilingParams, tier: "defaults", fInfFit, tauFit };
}

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
/** Yield to the event loop this often during a bootstrap loop so the
 * browser tab stays responsive across ~100 sequential refits. */
export const BOOTSTRAP_YIELD_EVERY = 10;

export interface TauConfidenceInterval {
  /** Which tier the POINT ESTIMATE (not each resample) used -- "defaults"
   * never reaches this far; bootstrapTauConfidenceInterval returns null
   * instead, since there's nothing to build an interval around. */
  tier: "joint" | "tauOnly";
  pointEstimateTauMin: number;
  /** Full ceilingParams (fInf + tauMin) from the point estimate -- exposed
   * so downstream callers (finishTimeRange.ts's solver-based band) don't
   * need to re-run fitTauFInfWithSupportGate themselves. */
  pointEstimateCeilingParams: CeilingParams;
  lowTauMin: number;
  medianTauMin: number;
  highTauMin: number;
  /** Retained per-resample tauMin values, sorted ascending -- exposed for
   * callers that need more than tau's own percentiles (e.g.
   * finishTimeRange.ts runs each one through the solver to build a
   * finish-time distribution) without re-running the bootstrap themselves. */
  tauSamples: number[];
  /** Resamples that produced a usable tau-only fit and were included above. */
  sampleCount: number;
  /** Resamples dropped for failing the same support gate the point
   * estimate had to clear -- see the module-level note on why these are
   * skipped rather than substituted with a default value. */
  skippedCount: number;
}

/**
 * Nonparametric bootstrap confidence interval on tau: resamples races with
 * replacement, refits tau on each resample (holding fInf fixed at whatever
 * the point estimate resolved to -- see fitTauFInfWithSupportGate), and
 * reports percentiles across the retained resamples. A cleaner question
 * than finishTimeRange.ts's own sensitivity band: this is a standard
 * "how much would tau vary if I'd sampled a slightly different set of my
 * own training races" bootstrap CI on a fitted parameter, not a claim
 * about real-world finish-time variance.
 *
 * Null when the point estimate itself can't clear the support gate (the
 * real Soria Moria case: not enough informative races even for a tau-only
 * fit) -- refusing a number here mirrors fitTauFInfWithSupportGate's own
 * "defaults" tier refusing to trust a single-race-driven fit.
 *
 * A resample that can't itself clear the same informative-race-count gate
 * is SKIPPED, not replaced with a default value: mixing "genuinely refit"
 * samples with "fell back to defaults" samples in one distribution
 * produces a bimodal, meaningless spread, not a wide-but-honest one --
 * this is exactly why naive bootstrap-over-races is degenerate at low
 * informativeRaceCount (the real Soria Moria case, informativeRaceCount=1/27).
 */
export async function bootstrapTauConfidenceInterval(
  races: EffortTrendPoint[][],
  raceDates: (Date | null)[],
  ceilingParams: CeilingParams,
  opts: BootstrapOptions = {},
): Promise<TauConfidenceInterval | null> {
  const bootstrapSamples = opts.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const rng = opts.rng ?? Math.random;

  const pointFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates });
  if (pointFit.tier === "defaults") return null;

  const pointEstimateTauMin = pointFit.ceilingParams.tauMin!;
  const tauSamples: number[] = [];
  let skippedCount = 0;

  for (let i = 0; i < bootstrapSamples; i++) {
    if (i > 0 && i % BOOTSTRAP_YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const indices = races.map(() => Math.floor(rng() * races.length));
    const resampledRaces = indices.map((idx) => races[idx]);
    const resampledDates = indices.map((idx) => raceDates[idx]);

    const tauFit = fitTauAcrossRaces(resampledRaces, pointFit.ceilingParams, { raceDates: resampledDates });
    if (!tauFit || tauFit.informativeRaceCount < MIN_INFORMATIVE_RACES || tauFit.hitSearchBoundary) {
      skippedCount++;
      continue;
    }
    tauSamples.push(tauFit.tauMin);
  }

  tauSamples.sort((a, b) => a - b);
  const sampleCount = tauSamples.length;
  const [low, median, high] =
    sampleCount > 0
      ? [percentile(tauSamples, 0.1), percentile(tauSamples, 0.5), percentile(tauSamples, 0.9)]
      : [pointEstimateTauMin, pointEstimateTauMin, pointEstimateTauMin];

  return {
    tier: pointFit.tier,
    pointEstimateTauMin,
    pointEstimateCeilingParams: pointFit.ceilingParams,
    lowTauMin: low,
    medianTauMin: median,
    highTauMin: high,
    tauSamples,
    sampleCount,
    skippedCount,
  };
}

export interface FitImprovementSuggestion {
  severity: "warning" | "info";
  message: string;
}

/** Heuristic, not a statistically derived threshold: above this fraction of
 * the point estimate, the tau confidence interval is called out as worth
 * narrowing. There's no principled cutoff here -- it's a "this is
 * noticeably wide" flag, not a calibrated significance test. */
const WIDE_TAU_CI_FRACTION = 0.3;

/**
 * Turns the diagnostics fitTauAcrossRaces/fitFInfAndTauAcrossRaces/
 * bootstrapTauConfidenceInterval already compute (informativeRaceCount,
 * durationDiversityRatio, hitSearchBoundary, the CI's own width) into
 * concrete, actionable suggestions for what to add to the training
 * library -- rather than reporting numbers and leaving the athlete to
 * work out what they imply. Checks tau's own fit first (the thing that
 * blocks everything else if unsupported), then the joint fInf/tau fit,
 * then the tau CI's width if one has been computed.
 *
 * Returns an empty array only when tauFit is null AND fInfFit is null AND
 * no tauCI was supplied -- i.e. there's nothing at all to say yet. When a
 * tauFit exists and every check clears, returns a single reassuring "info"
 * entry rather than an empty list, so the UI has something to render
 * either way.
 */
export function suggestFitImprovements(
  tauFit: MultiRaceTauFitResult | null,
  fInfFit: FInfTauFitResult | null,
  tauCI?: TauConfidenceInterval | null,
): FitImprovementSuggestion[] {
  const suggestions: FitImprovementSuggestion[] = [];

  if (!tauFit) {
    if (!fInfFit) return suggestions;
  } else if (tauFit.informativeRaceCount < MIN_INFORMATIVE_RACES) {
    const needed = MIN_INFORMATIVE_RACES - tauFit.informativeRaceCount;
    suggestions.push({
      severity: "warning",
      message:
        `Only ${tauFit.informativeRaceCount} of your ${tauFit.perRace.length} selected runs are actually long ` +
        `enough to inform tau -- add at least ${needed} more multi-hour effort${needed === 1 ? "" : "s"} (see which ` +
        `ones are flagged "unresponsive" above).`,
    });
  } else if (tauFit.hitSearchBoundary) {
    const direction = tauFit.hitSearchBoundary === "upper" ? "longer" : "shorter";
    suggestions.push({
      severity: "warning",
      message:
        `Your tau estimate landed at the ${tauFit.hitSearchBoundary} edge of the search range -- the true value ` +
        `may be even ${tauFit.hitSearchBoundary === "upper" ? "larger" : "smaller"}. Add a ${direction} run to pin it down.`,
    });
  }

  if (fInfFit) {
    if (fInfFit.durationDiversityRatio < MIN_DURATION_DIVERSITY_RATIO) {
      suggestions.push({
        severity: "warning",
        message:
          `Your runs span only a ${fInfFit.durationDiversityRatio.toFixed(1)}x duration range (longest ÷ ` +
          `shortest) -- your long runs are too similar in length. Add one at least ${MIN_DURATION_DIVERSITY_RATIO}x ` +
          `longer or shorter than your current spread to also estimate fInf, not just tau.`,
      });
    } else if (fInfFit.informativeRaceCount < MIN_INFORMATIVE_RACES) {
      suggestions.push({
        severity: "warning",
        message:
          `Your runs span a wide duration range, but only ${fInfFit.informativeRaceCount} of them actually ` +
          `inform the joint fInf/tau fit -- add more multi-hour efforts, not just longer ones.`,
      });
    } else if (fInfFit.hitSearchBoundary.fInf || fInfFit.hitSearchBoundary.tau) {
      const params = [fInfFit.hitSearchBoundary.fInf && "fInf", fInfFit.hitSearchBoundary.tau && "tau"]
        .filter(Boolean)
        .join(" and ");
      suggestions.push({
        severity: "warning",
        message: `The joint fit hit a search boundary on ${params} -- treat those as bounds, and add more (or longer) runs to narrow them down.`,
      });
    }
  }

  if (tauCI) {
    const widthFraction = (tauCI.highTauMin - tauCI.lowTauMin) / tauCI.pointEstimateTauMin;
    if (widthFraction > WIDE_TAU_CI_FRACTION) {
      suggestions.push({
        severity: "warning",
        message:
          `Your tau confidence interval spans ${(widthFraction * 100).toFixed(0)}% of the point estimate ` +
          `(${tauCI.lowTauMin.toFixed(0)}-${tauCI.highTauMin.toFixed(0)} min around ${tauCI.pointEstimateTauMin.toFixed(0)} min) ` +
          `-- more runs, especially long ones, would narrow this down.`,
      });
    }
  }

  if (suggestions.length === 0 && tauFit) {
    suggestions.push({
      severity: "info",
      message: "This fit looks well-supported. More long runs would still tighten it further, but nothing here looks broken.",
    });
  }

  return suggestions;
}

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

function descentExposureSelectorFor(basis: DescentExposureBasis): (p: EffortTrendPoint) => number {
  switch (basis) {
    case "descentMeters":
      return (p) => p.cumulativeDescentM ?? 0;
    case "descentImpact":
      return (p) => p.cumulativeDescentImpact ?? 0;
    case "descentImpactSquared":
      return (p) => p.cumulativeDescentImpactSquared ?? 0;
  }
}

export interface DescentDriftFitResult {
  durabilityDriftPerDescentUnit: number;
  trendAtFitPctPerHour: number;
}

/**
 * Same "hold tau/f0/fInf fixed, search one axis" shape as
 * fitDurabilityDriftPerHour above, but keyed to cumulative descent exposure
 * (under the chosen basis) instead of elapsed time -- the muscular-endurance
 * term from PLAN.md §12/§13 stage 5, distinct from that function's
 * wall-clock-time mechanism. Same lower-confidence framing applies: this is
 * an alternative reading of a downward trend, not something identifiable
 * jointly with tau from a single race.
 *
 * Unlike fitDurabilityDriftPerHour's fixed [0, 0.06] default range --
 * elapsed hours are always on the same rough scale (a handful to a few tens
 * of hours) -- descent exposure's scale varies by orders of magnitude
 * depending on the basis (raw meters vs. meters*speed vs. meters*speed^2),
 * so the default range is derived from the max cumulative exposure actually
 * observed across the points, the same way fitTauMinutes derives its own
 * range from the race's duration rather than a flat constant.
 */
export function fitDurabilityDriftPerDescentUnit(
  points: EffortTrendPoint[],
  basis: DescentExposureBasis,
  ceilingParams: CeilingParams,
  range?: [number, number],
): DescentDriftFitResult | null {
  const trimmed = trimForPacingFit(points);
  if (trimmed.length < MIN_FIT_POINTS) return null;

  const selector = descentExposureSelectorFor(basis);
  const maxExposure = Math.max(...trimmed.map(selector));
  if (!(maxExposure > 0)) return null; // no descent recorded -- a rate isn't identifiable from nothing to act on

  // Upper bound chosen so the rate can, at the most-exposed point observed,
  // fully saturate the ceiling to 0 (driftFactor = max(0, 1 - rate*exposure)) --
  // comfortably past any physiologically real value, the same "let the
  // search range include the degenerate extreme rather than clip short of
  // it" approach fitDurabilityDriftPerHour's [0, 0.06] already takes (0.06
  // over a ~17h race also approaches full saturation).
  const resolvedRange: [number, number] = range ?? [0, 1.5 / maxExposure];

  const search = (lo: number, hi: number, step: number) => {
    let best = lo;
    let bestAbsSlope = Infinity;
    for (let drift = lo; drift <= hi; drift += step) {
      const trend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerDescentUnit: drift }, selector);
      if (trend && Math.abs(trend.slopePerHour) < bestAbsSlope) {
        bestAbsSlope = Math.abs(trend.slopePerHour);
        best = drift;
      }
    }
    return best;
  };

  const [lo, hi] = resolvedRange;
  const coarseStep = (hi - lo) / 30;
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), coarseStep / 10);

  const fittedTrend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerDescentUnit: fine }, selector);
  if (!fittedTrend) return null;

  return {
    durabilityDriftPerDescentUnit: fine,
    trendAtFitPctPerHour: fittedTrend.slopePerHour * 100,
  };
}

export interface MultiRaceDescentDriftFitResult {
  durabilityDriftPerDescentUnit: number;
  perRace: {
    trendAtCurrentPctPerHour: number;
    trendAtFitPctPerHour: number;
    /** True if this race barely accumulated any descent exposure under the
     * chosen basis -- the fitted rate has essentially no effect on its own
     * ceiling regardless of what the rate is, the same "sat through this
     * fit without actually informing it" idea as fitTauAcrossRaces's own
     * unresponsive flag, just measured via exposure instead of ceiling
     * saturation. */
    unresponsive: boolean;
  }[];
  /** See MIN_INFORMATIVE_RACES's doc above -- count of perRace entries with
   * unresponsive === false. */
  informativeRaceCount: number;
  hitSearchBoundary: "lower" | "upper" | null;
}

/**
 * Same "pool per-race squared slope, not one flat concatenated regression"
 * shape as fitTauAcrossRaces above (see its own doc comment for why:
 * concatenating races across different average efforts confounds cross-
 * race effort differences with fatigue shape) -- applied here to the
 * descent-exposure drift term instead of tau. Holds tau/f0/fInf fixed at
 * whatever's in ceilingParams, exactly as fitTauAcrossRaces holds f0/fInf
 * fixed for its own tau search. Backtest tooling (scripts/backtestFinishTime.ts)
 * is the reason this pooled version exists at all -- fitting a shared
 * drift rate across a training set of races, not just recovering one from
 * a single race.
 *
 * Important interpretive caveat this function can't enforce on its own:
 * within a single race, cumulative descent exposure is close to monotonic
 * in elapsed time, so an in-sample fit here is easily confounded with
 * tau/time-based drift already explaining the same downward trend -- a
 * good in-sample fit is close to guaranteed by construction and is NOT by
 * itself evidence that descent exposure matters physiologically. Real
 * evidence has to come from out-of-sample prediction accuracy (comparing a
 * held-out race's actual finish time against candidates with and without
 * this term), not from how well it flattens the training races it was fit
 * on.
 */
export function fitDurabilityDriftPerDescentUnitAcrossRaces(
  races: EffortTrendPoint[][],
  basis: DescentExposureBasis,
  ceilingParams: CeilingParams,
  opts: FitTauAcrossRacesOptions = {},
): MultiRaceDescentDriftFitResult | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();
  const selector = descentExposureSelectorFor(basis);

  const trimmedWithWeight = races
    .map((r, i) => {
      const date = opts.raceDates?.[i] ?? null;
      return {
        points: trimForPacingFit(r),
        recencyWeight: date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1,
      };
    })
    .filter((r) => r.points.length >= MIN_FIT_POINTS);
  if (trimmedWithWeight.length === 0) return null;

  const trimmed = trimmedWithWeight.map((r) => r.points);
  const recencyWeights = trimmedWithWeight.map((r) => r.recencyWeight);

  const currentTrends = trimmed.map((r) => computeEffortTrend(r, ceilingParams, selector));
  if (currentTrends.some((t) => !t)) return null;

  // Range derived from the max exposure observed across ALL pooled races,
  // not any single one -- a rate scaled to the most-exposed race would
  // barely register on a race with much less exposure, and vice versa.
  const maxExposurePerRace = trimmed.map((r) => Math.max(...r.map(selector)));
  const overallMaxExposure = Math.max(...maxExposurePerRace);
  if (!(overallMaxExposure > 0)) return null; // no descent recorded anywhere -- a rate isn't identifiable from nothing

  const lo = 0;
  const hi = 1.5 / overallMaxExposure;

  const pooledSquaredSlope = (rate: number) => {
    let sum = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const trend = computeEffortTrend(trimmed[i], { ...ceilingParams, durabilityDriftPerDescentUnit: rate }, selector);
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  const search = (searchLo: number, searchHi: number, step: number) => {
    let bestRate = searchLo;
    let bestScore = Infinity;
    for (let rate = searchLo; rate <= searchHi; rate += step) {
      const score = pooledSquaredSlope(rate);
      if (score < bestScore) {
        bestScore = score;
        bestRate = rate;
      }
    }
    return bestRate;
  };

  const coarseStep = (hi - lo) / 40;
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), Math.max(coarseStep / 100, (hi - lo) / 10000));

  const durabilityDriftPerDescentUnit = fine;
  const fittedTrends = trimmed.map((r) => computeEffortTrend(r, { ...ceilingParams, durabilityDriftPerDescentUnit }, selector));
  if (fittedTrends.some((t) => !t)) return null;

  const boundaryEpsilon = (hi - lo) / 1000;
  const hitSearchBoundary =
    durabilityDriftPerDescentUnit <= lo + boundaryEpsilon
      ? "lower"
      : durabilityDriftPerDescentUnit >= hi - boundaryEpsilon
        ? "upper"
        : null;

  const perRace = currentTrends.map((current, i) => ({
    trendAtCurrentPctPerHour: current!.slopePerHour * 100,
    trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
    unresponsive: durabilityDriftPerDescentUnit * maxExposurePerRace[i] < MIN_CEILING_DROP_FRACTION,
  }));

  return {
    durabilityDriftPerDescentUnit,
    perRace,
    informativeRaceCount: perRace.filter((r) => !r.unresponsive).length,
    hitSearchBoundary,
  };
}

export interface SurfaceDriftFitResult {
  durabilityDriftPerUnpavedUnit: number;
  trendAtFitPctPerHour: number;
}

function unpavedExposure(p: EffortTrendPoint): number {
  return p.cumulativeUnpavedM ?? 0;
}

/**
 * Same "hold tau/f0/fInf fixed, search one axis" shape as
 * fitDurabilityDriftPerDescentUnit above, keyed to cumulative unpaved/
 * technical-trail distance instead of descent -- terrain difficulty the
 * grade/altitude model alone doesn't capture. Unlike descent, there's only
 * one exposure metric here (raw unpaved meters, already validated by a
 * leave-one-out backtest across 31 real races: 28 improved, 0 regressed),
 * not several candidate bases to keep alive -- so no `basis` parameter.
 *
 * Returns null both when this race has no surface data at all (never
 * classified -- see EffortTrendPoint.cumulativeUnpavedM's own doc) and when
 * it does but is genuinely 0% unpaved throughout (a real result, just one
 * that can't identify a rate) -- either way, a single race with nothing to
 * act on can't inform this fit.
 */
export function fitSurfaceDriftPerUnpavedUnit(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  range?: [number, number],
): SurfaceDriftFitResult | null {
  const trimmed = trimForPacingFit(points);
  if (trimmed.length < MIN_FIT_POINTS) return null;
  if (!trimmed.some((p) => p.cumulativeUnpavedM !== undefined)) return null;

  const maxExposure = Math.max(...trimmed.map(unpavedExposure));
  if (!(maxExposure > 0)) return null;

  // Same "let the rate's range include full saturation" approach as
  // fitDurabilityDriftPerDescentUnit's own [0, 1.5/maxExposure].
  const resolvedRange: [number, number] = range ?? [0, 1.5 / maxExposure];

  const search = (lo: number, hi: number, step: number) => {
    let best = lo;
    let bestAbsSlope = Infinity;
    for (let drift = lo; drift <= hi; drift += step) {
      const trend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerUnpavedUnit: drift }, undefined, unpavedExposure);
      if (trend && Math.abs(trend.slopePerHour) < bestAbsSlope) {
        bestAbsSlope = Math.abs(trend.slopePerHour);
        best = drift;
      }
    }
    return best;
  };

  const [lo, hi] = resolvedRange;
  const coarseStep = (hi - lo) / 30;
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), coarseStep / 10);

  const fittedTrend = computeEffortTrend(trimmed, { ...ceilingParams, durabilityDriftPerUnpavedUnit: fine }, undefined, unpavedExposure);
  if (!fittedTrend) return null;

  return {
    durabilityDriftPerUnpavedUnit: fine,
    trendAtFitPctPerHour: fittedTrend.slopePerHour * 100,
  };
}

export interface MultiRaceSurfaceDriftFitResult {
  durabilityDriftPerUnpavedUnit: number;
  perRace: {
    trendAtCurrentPctPerHour: number;
    trendAtFitPctPerHour: number;
    /** True if this race has no surface data at all, or has essentially no
     * unpaved distance for the fitted rate to act on -- same "sat through
     * this fit without informing it" idea as the descent/tau fits' own
     * unresponsive flag. */
    unresponsive: boolean;
  }[];
  /** See MIN_INFORMATIVE_RACES's doc above -- count of perRace entries with
   * unresponsive === false. */
  informativeRaceCount: number;
  hitSearchBoundary: "lower" | "upper" | null;
}

/**
 * Pooled version of fitSurfaceDriftPerUnpavedUnit, same "sum of squared
 * per-race slopes" shape as fitDurabilityDriftPerDescentUnitAcrossRaces.
 * Races with no surface data at all are excluded from the pool entirely
 * (not treated as 0% unpaved) -- everything else follows that function's
 * own reasoning, including its interpretive caveat: a good in-sample fit
 * here is close to guaranteed by construction (cumulative unpaved distance
 * is monotonic in elapsed time within a race, easily confounded with
 * tau/time-based drift), so real evidence has to come from out-of-sample
 * prediction accuracy, not from how well this flattens its own training
 * races -- exactly what this term was validated with before being added.
 */
export function fitSurfaceDriftAcrossRaces(
  races: EffortTrendPoint[][],
  ceilingParams: CeilingParams,
  opts: FitTauAcrossRacesOptions = {},
): MultiRaceSurfaceDriftFitResult | null {
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const now = opts.now ?? new Date();

  const trimmedWithWeight = races
    .map((r, i) => {
      const date = opts.raceDates?.[i] ?? null;
      return {
        points: trimForPacingFit(r),
        recencyWeight: date ? Math.exp((-Math.LN2 * daysAgo(date, now)) / halfLifeDays) : 1,
      };
    })
    .filter((r) => r.points.length >= MIN_FIT_POINTS && r.points.some((p) => p.cumulativeUnpavedM !== undefined));
  if (trimmedWithWeight.length === 0) return null;

  const trimmed = trimmedWithWeight.map((r) => r.points);
  const recencyWeights = trimmedWithWeight.map((r) => r.recencyWeight);

  const currentTrends = trimmed.map((r) => computeEffortTrend(r, ceilingParams, undefined, unpavedExposure));
  if (currentTrends.some((t) => !t)) return null;

  const maxExposurePerRace = trimmed.map((r) => Math.max(...r.map(unpavedExposure)));
  const overallMaxExposure = Math.max(...maxExposurePerRace);
  if (!(overallMaxExposure > 0)) return null; // surface data present, but genuinely 0% unpaved everywhere

  const lo = 0;
  const hi = 1.5 / overallMaxExposure;

  const pooledSquaredSlope = (rate: number) => {
    let sum = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const trend = computeEffortTrend(trimmed[i], { ...ceilingParams, durabilityDriftPerUnpavedUnit: rate }, undefined, unpavedExposure);
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  const search = (searchLo: number, searchHi: number, step: number) => {
    let bestRate = searchLo;
    let bestScore = Infinity;
    for (let rate = searchLo; rate <= searchHi; rate += step) {
      const score = pooledSquaredSlope(rate);
      if (score < bestScore) {
        bestScore = score;
        bestRate = rate;
      }
    }
    return bestRate;
  };

  const coarseStep = (hi - lo) / 40;
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), Math.max(coarseStep / 100, (hi - lo) / 10000));

  const durabilityDriftPerUnpavedUnit = fine;
  const fittedTrends = trimmed.map((r) => computeEffortTrend(r, { ...ceilingParams, durabilityDriftPerUnpavedUnit }, undefined, unpavedExposure));
  if (fittedTrends.some((t) => !t)) return null;

  const boundaryEpsilon = (hi - lo) / 1000;
  const hitSearchBoundary =
    durabilityDriftPerUnpavedUnit <= lo + boundaryEpsilon ? "lower" : durabilityDriftPerUnpavedUnit >= hi - boundaryEpsilon ? "upper" : null;

  const perRace = currentTrends.map((current, i) => ({
    trendAtCurrentPctPerHour: current!.slopePerHour * 100,
    trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
    unresponsive: durabilityDriftPerUnpavedUnit * maxExposurePerRace[i] < MIN_CEILING_DROP_FRACTION,
  }));

  return {
    durabilityDriftPerUnpavedUnit,
    perRace,
    informativeRaceCount: perRace.filter((r) => !r.unresponsive).length,
    hitSearchBoundary,
  };
}
