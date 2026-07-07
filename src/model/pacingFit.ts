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

import { type CeilingParams, ceilingPower } from "./ceiling";

export interface EffortTrendPoint {
  /** Hours elapsed since the start of the run, at the start of this segment. */
  tHours: number;
  grossPowerWPerKg: number;
  altitudeM: number;
  /** Segment duration, seconds -- used as the regression weight. */
  dtS: number;
}

interface TrendFit {
  /** Effort-fraction change per hour (e.g. 0.05 = effort rising ~5 percentage points/hour). */
  slopePerHour: number;
}

/** Weighted least-squares slope of effort (grossPower/ceiling) vs. elapsed hours. */
function effortTrend(points: EffortTrendPoint[], ceilingParams: CeilingParams): TrendFit | null {
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

const MIN_FIT_POINTS = 10;

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

  const currentTrend = effortTrend(trimmed, ceilingParams);
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
      const trend = effortTrend(trimmed, { ...ceilingParams, tauMin: tau });
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

  const fittedTrend = effortTrend(trimmed, { ...ceilingParams, tauMin: fine });
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
      const trend = effortTrend(trimmed, { ...ceilingParams, durabilityDriftPerHour: drift });
      if (trend && Math.abs(trend.slopePerHour) < bestAbsSlope) {
        bestAbsSlope = Math.abs(trend.slopePerHour);
        best = drift;
      }
    }
    return best;
  };

  const coarse = search(range[0], range[1], 0.002);
  const fine = search(Math.max(range[0], coarse - 0.0018), Math.min(range[1], coarse + 0.0018), 0.0002);

  const fittedTrend = effortTrend(trimmed, { ...ceilingParams, durabilityDriftPerHour: fine });
  if (!fittedTrend) return null;

  return {
    durabilityDriftPerHour: fine,
    trendAtFitPctPerHour: fittedTrend.slopePerHour * 100,
  };
}
