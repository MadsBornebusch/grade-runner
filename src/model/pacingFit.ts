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

export interface EffortTrendPoint {
  /** Hours elapsed since the start of the run, at the start of this segment. */
  tHours: number;
  grossPowerWPerKg: number;
  altitudeM: number;
  /** Segment duration, seconds -- used as the regression weight. */
  dtS: number;
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
  return analysisSegments
    .filter((s) => s.effortFraction !== null)
    .map((s) => ({
      tHours: (s.cumulativeElapsedTimeS - s.timeS) / 3600,
      grossPowerWPerKg: s.grossPowerWPerKg,
      altitudeM: altitudeAdjustment ? courseSegments[s.index]?.elevation ?? 0 : 0,
      dtS: s.timeS,
    }));
}

export interface TrendFit {
  /** Effort-fraction change per hour (e.g. 0.05 = effort rising ~5 percentage points/hour). */
  slopePerHour: number;
}

/** Weighted least-squares slope of effort (grossPower/ceiling) vs. elapsed hours.
 * Exported for reuse by withinRaceDescentDiagnostic.ts, which needs the same
 * slope computation restricted to a sub-window of a race's points. */
export function computeEffortTrend(points: EffortTrendPoint[], ceilingParams: CeilingParams): TrendFit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  for (const p of points) {
    const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
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

export function fitTauMinutes(
  points: EffortTrendPoint[],
  ceilingParams: CeilingParams,
  range?: [number, number],
): TauFitResult | null {
  const trimmed = trimForPacingFit(points);
  if (trimmed.length < MIN_FIT_POINTS) return null;

  const currentTrend = computeEffortTrend(trimmed, ceilingParams);
  if (!currentTrend) return null;

  const totalMin = trimmed[trimmed.length - 1].tHours * 60;
  const resolvedRange: [number, number] = range ?? [
    Math.max(20, totalMin * 0.3),
    Math.min(ABSOLUTE_MAX_TAU_MIN, Math.max(totalMin * 2.5, totalMin * 0.3 + 40)),
  ];

  const search = (lo: number, hi: number, step: number) => {
    let bestTau = lo;
    let bestAbsSlope = Infinity;
    for (let tau = lo; tau <= hi; tau += step) {
      const trend = computeEffortTrend(trimmed, { ...ceilingParams, tauMin: tau });
      if (trend && Math.abs(trend.slopePerHour) < bestAbsSlope) {
        bestAbsSlope = Math.abs(trend.slopePerHour);
        bestTau = tau;
      }
    }
    return bestTau;
  };

  const [lo, hi] = resolvedRange;
  const coarseStep = Math.max(2, (hi - lo) / 40);
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), Math.max(1, coarseStep / 10));

  const fittedTrend = computeEffortTrend(trimmed, { ...ceilingParams, tauMin: fine });
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

  const currentTrends = trimmed.map((r) => computeEffortTrend(r, ceilingParams));
  if (currentTrends.some((t) => !t)) return null;

  const totalMinPerRace = trimmed.map((r) => r[r.length - 1].tHours * 60);
  const lo = Math.max(20, Math.min(...totalMinPerRace) * 0.3);
  const hi = Math.min(ABSOLUTE_MAX_TAU_MIN, Math.max(...totalMinPerRace) * 2.5);

  const pooledSquaredSlope = (tau: number) => {
    let sum = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const trend = computeEffortTrend(trimmed[i], { ...ceilingParams, tauMin: tau });
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  const search = (searchLo: number, searchHi: number, step: number) => {
    let bestTau = searchLo;
    let bestScore = Infinity;
    for (let tau = searchLo; tau <= searchHi; tau += step) {
      const score = pooledSquaredSlope(tau);
      if (score < bestScore) {
        bestScore = score;
        bestTau = tau;
      }
    }
    return bestTau;
  };

  const coarseStep = Math.max(2, (hi - lo) / 40);
  const coarse = search(lo, hi, coarseStep);
  const fine = search(Math.max(lo, coarse - coarseStep), Math.min(hi, coarse + coarseStep), Math.max(1, coarseStep / 10));

  const tauMin = Math.round(fine);
  const fittedTrends = trimmed.map((r) => computeEffortTrend(r, { ...ceilingParams, tauMin }));
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

  return {
    tauMin,
    perRace: currentTrends.map((current, i) => ({
      trendAtCurrentPctPerHour: current!.slopePerHour * 100,
      trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
      unresponsive: ceilingDropFraction(trimmed[i]) < MIN_CEILING_DROP_FRACTION,
    })),
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

  const currentTrends = trimmed.map((r) => computeEffortTrend(r, ceilingParams));
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
      const trend = computeEffortTrend(trimmed[i], { ...ceilingParams, fInf, tauMin: tau });
      if (!trend) return Infinity;
      sum += recencyWeights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };

  const search = (fLo: number, fHi: number, fStep: number, tLo: number, tHi: number, tStep: number) => {
    let best = { fInf: fLo, tau: tLo, score: Infinity };
    for (let fInf = fLo; fInf <= fHi; fInf += fStep) {
      for (let tau = tLo; tau <= tHi; tau += tStep) {
        const score = pooledSquaredSlope(fInf, tau);
        if (score < best.score) best = { fInf, tau, score };
      }
    }
    return best;
  };

  const coarseFStep = Math.max(0.01, (fInfHi - fInfLo) / 25);
  const coarseTStep = Math.max(2, (tauHi - tauLo) / 25);
  const coarse = search(fInfLo, fInfHi, coarseFStep, tauLo, tauHi, coarseTStep);

  const fine = search(
    Math.max(fInfLo, coarse.fInf - coarseFStep),
    Math.min(fInfHi, coarse.fInf + coarseFStep),
    Math.max(0.001, coarseFStep / 10),
    Math.max(tauLo, coarse.tau - coarseTStep),
    Math.min(tauHi, coarse.tau + coarseTStep),
    Math.max(1, coarseTStep / 10),
  );

  const fInf = Math.round(fine.fInf * 1000) / 1000;
  const tauMin = Math.round(fine.tau);

  const fittedTrends = trimmed.map((r) => computeEffortTrend(r, { ...ceilingParams, fInf, tauMin }));
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

  return {
    fInf,
    tauMin,
    durationDiversityRatio: Math.max(...totalMinPerRace) / Math.min(...totalMinPerRace),
    perRace: currentTrends.map((current, i) => ({
      trendAtCurrentPctPerHour: current!.slopePerHour * 100,
      trendAtFitPctPerHour: fittedTrends[i]!.slopePerHour * 100,
      unresponsive: ceilingDropFraction(trimmed[i]) < MIN_CEILING_DROP_FRACTION,
    })),
    hitSearchBoundary: {
      fInf: fInf <= fInfLo + 0.005 ? "lower" : fInf >= fInfHi - 0.005 ? "upper" : null,
      tau: tauMin <= tauLo + 1 ? "lower" : tauMin >= tauHi - 1 ? "upper" : null,
    },
  };
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
