// Aerobic power ceiling: duration-dependent sustainable fraction of VO2max,
// capped by LT2, adjusted for altitude and (optionally) durability drift.
// See PLAN.md §2 (Saltin fraction, Cerretelli altitude) and §5 P0/P1/P2
// corrections.

import { vo2ToPower, O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L } from "./energetics";

export interface CeilingParams {
  /** VO2max at sea level, ml O2 · kg⁻¹ · min⁻¹. Default 50. */
  vo2MaxMlPerKgPerMin?: number;
  /** LT2 as a fraction of VO2max — hard cap on sustainable fraction. Default 0.85. */
  lt2Fraction?: number;
  /** Duration->fraction decay curve parameters (PLAN.md §5 P0 fix for Saltin). */
  f0?: number;
  fInf?: number;
  tauMin?: number;
  /** Fraction lost per hour of elapsed racing, applied on top of the ceiling. 0 = off (default). */
  durabilityDriftPerHour?: number;
  /**
   * PLAN.md §12/§13 stage 5: a second, independent durability term keyed to
   * cumulative descent-based exposure instead of elapsed time (see
   * CeilingInput.descentExposure) -- muscular/eccentric-load fatigue,
   * distinct from durabilityDriftPerHour's wall-clock-time mechanism.
   * Fraction lost per unit of that exposure. 0 = off (default). Additive,
   * not a replacement: both terms can be active at once, multiplying
   * together, or either can be used alone.
   */
  durabilityDriftPerDescentUnit?: number;
  /**
   * Master on/off switch for all time/exposure-based fade -- the f0->fInf
   * duration curve below, AND both durabilityDrift terms in ceilingPower
   * (they're a second fade mechanism layered on top of this one, so "no
   * fade" has to silence both, not just the curve). Default true (on).
   * False returns a flat ceiling at f0 (capped by LT2) regardless of
   * elapsed time or descent exposure -- for an athlete who doesn't trust,
   * or doesn't want, any fade modeling in their plan.
   */
  pacingCurveEnabled?: boolean;
  /**
   * Which duration->fraction shape to use. "exponential" (the default, and
   * byte-for-byte the behavior that existed before this field) is the
   * f0/fInf/tauMin bounded decay above. "powerLaw" instead uses
   * powerLawFraction60Min/powerLawExponent below.
   *
   * Motivated by a measured failure of the exponential across this
   * athlete's own 8 confirmed races (42min-24h): real sustained fraction of
   * VO2max spans 86%->41% (a factor of 2.1), while the fitted exponential
   * spans only 83%->66% (a factor of 1.26). fInf is the culprit -- it's an
   * asymptote no single race ever reaches, so the within-race fit that
   * produces it leaves it essentially unconstrained, and it ends up far too
   * high (0.66 against a real 24h value of 0.41). A power law has no
   * absorbing asymptote and fits the whole range.
   *
   * IMPORTANT: pacingFit.ts's tau/fInf fits call ceilingPower directly on
   * real recorded elapsed time to search EXPONENTIAL parameters. Handing
   * them params in "powerLaw" mode would have them fitting an exponential
   * against a power-law ceiling -- meaningless. Those fits force
   * "exponential" explicitly; see forceExponentialCurve below.
   */
  durationCurve?: "exponential" | "powerLaw";
  /**
   * Sustainable fraction of VO2max at 60 minutes -- the power law's anchor.
   * Deliberately anchored at 60min rather than at t=1 (whose raw
   * coefficient is a meaningless extrapolation well above 1.0): LT2 is
   * conventionally about an athlete's 60-minute power, so this should land
   * near lt2Fraction and is directly checkable against it. For the athlete
   * this was developed against, the envelope fit gave 0.813 versus a
   * lab-measured lt2Fraction of 0.814.
   */
  powerLawFraction60Min?: number;
  /** Decay exponent b in f(t) = f60 * (t/60)^-b. Positive; larger means a
   * steeper fall-off with duration. ~0.16 for the athlete this was
   * developed against. */
  powerLawExponent?: number;
}

/**
 * Strips `durationCurve` back to "exponential" -- for pacingFit.ts's
 * tau/fInf searches, which are only meaningful against the exponential
 * shape they're searching parameters of (see durationCurve's own doc). A
 * no-op for params already in exponential mode, so it's safe to apply
 * unconditionally at those call sites.
 */
export function forceExponentialCurve(params: CeilingParams): CeilingParams {
  return params.durationCurve === "powerLaw" ? { ...params, durationCurve: "exponential" } : params;
}

const DEFAULTS: Required<CeilingParams> = {
  vo2MaxMlPerKgPerMin: 50,
  lt2Fraction: 0.85,
  f0: 0.94,
  fInf: 0.38,
  tauMin: 250,
  durabilityDriftPerHour: 0,
  durabilityDriftPerDescentUnit: 0,
  pacingCurveEnabled: true,
  durationCurve: "exponential",
  powerLawFraction60Min: 0.81,
  powerLawExponent: 0.16,
};

/** Aerobic ceiling in powerLaw mode is capped here rather than at
 * lt2Fraction: a power law has no plateau and climbs past 100% of VO2max
 * below ~16 minutes, which is not a thing aerobic metabolism can do. The
 * supra-VO2max part of a genuinely short race is anaerobic, and is modeled
 * separately (and additively) by anaerobicCapacityMultiplier -- so clamping
 * the AEROBIC term at VO2max here doesn't cap total power at VO2max.
 *
 * Note this replaces the lt2Fraction clamp in powerLaw mode, deliberately:
 * that clamp is what held every race under ~2h to an identical ceiling, and
 * it sat BELOW a real 42-minute race this athlete had already run (86.1%
 * actual vs an 81.4% clamp), so it was not functioning as an upper bound at
 * all. The fitted power law encodes the short-race behavior directly
 * instead. */
const MAX_AEROBIC_FRACTION = 1;

/**
 * Sustainable fraction of VO2max as a function of event duration so far,
 * minutes. Bounded decay (replaces Saltin's `(940-t)/1000`, which goes
 * negative past ~15.6h) always capped by LT2.
 */
export function sustainableFraction(
  tMin: number,
  params: CeilingParams = {},
): number {
  const { f0, fInf, tauMin, lt2Fraction, pacingCurveEnabled, durationCurve, powerLawFraction60Min, powerLawExponent } =
    { ...DEFAULTS, ...params };
  if (!pacingCurveEnabled) return Math.min(f0, lt2Fraction);
  if (durationCurve === "powerLaw") {
    // Guard t<=0 (and the t->0 blow-up generally) via the same VO2max cap
    // that bounds the short end -- see MAX_AEROBIC_FRACTION's own doc.
    if (!(tMin > 0)) return MAX_AEROBIC_FRACTION;
    return Math.min(powerLawFraction60Min * Math.pow(tMin / 60, -powerLawExponent), MAX_AEROBIC_FRACTION);
  }
  const fraction = fInf + (f0 - fInf) * Math.exp(-tMin / tauMin);
  return Math.min(fraction, lt2Fraction);
}

/** Below this many minutes, anaerobicCapacityMultiplier holds its value flat
 * instead of continuing to extrapolate 1+k/t -- the critical-power model's
 * own cited validity window bottoms out around 2 minutes (see PLAN.md §13's
 * citation check), and an unfloored hyperbola blows up as t->0. */
const MIN_ANAEROBIC_BOOST_T_MIN = 2;

/**
 * Critical-power/critical-speed short-race boost: how far ABOVE the
 * LT2-anchored ceiling a race of duration `tMin` can sustain, on top of
 * sustainableFraction's own long-race fade curve -- Monod & Scherrer's
 * hyperbolic P(t) = CP + W'/t (see Poole, Burnley, Vanhatalo & Jones'
 * reviews), reparameterized as a multiplier: `1 + anaerobicCapacityMin / t`.
 * `anaerobicCapacityMin` is W'/CP expressed in minutes -- how many minutes
 * of "extra" capacity above LT2 the athlete can draw down. 1 (no boost)
 * when `anaerobicCapacityMin` is 0 or `tMin` is non-positive; asymptotes to
 * 1 as `tMin` grows, so it's negligible (<2%) beyond ~90 minutes without
 * needing an explicit cutoff.
 *
 * Deliberately NOT folded into sustainableFraction/ceilingPower: those are
 * called directly by pacingFit.ts on real recorded elapsed time to fit
 * tau/fInf from historical races, and this term would corrupt that fit
 * (inflating the ceiling -- and so deflating the effort-fraction trend --
 * for the first ~90 minutes of every race in the training set, not just
 * short ones). solver.ts applies this separately, only in forward
 * simulation, exactly the way unpavedCostMultiplier is threaded through
 * SolverInputs rather than folded into CeilingParams for its own,
 * analogous reason (see that field's own doc).
 */
export function anaerobicCapacityMultiplier(tMin: number, anaerobicCapacityMin: number): number {
  if (anaerobicCapacityMin <= 0 || tMin <= 0) return 1;
  return 1 + anaerobicCapacityMin / Math.max(tMin, MIN_ANAEROBIC_BOOST_T_MIN);
}

/**
 * Fraction of VO2max available at altitude (Cerretelli), 1.0 at sea level.
 * ≈0.94 at 2000m, ≈0.80 at 4000m.
 */
export function altitudeFraction(altitudeM: number): number {
  const fraction = 1 - 11.7e-9 * altitudeM ** 2 - 4.01e-6 * altitudeM;
  return Math.max(0, Math.min(1, fraction));
}

export interface CeilingInput {
  /** Elapsed event duration so far, minutes — drives the duration->fraction curve. */
  tMin: number;
  /** Elevation of this segment/point, meters. Default 0 (sea level). */
  altitudeM?: number;
  /** Elapsed event duration so far, hours — drives optional durability drift. Defaults to tMin/60. */
  elapsedHours?: number;
  /**
   * Cumulative descent-based exposure so far, in whatever unit the caller
   * chose (raw descent meters, descent impact, or descent impact squared --
   * see descentImpact.ts) -- drives the optional durabilityDriftPerDescentUnit
   * term. ceilingPower doesn't care which metric this represents; tracking
   * and accumulating it is entirely the caller's responsibility (pacingFit.ts
   * for fitting, solver.ts for prediction), the same way elapsedHours above
   * doesn't have to be real wall-clock time either. Undefined (the default)
   * means no descent-based drift is applied, regardless of
   * durabilityDriftPerDescentUnit.
   */
  descentExposure?: number;
}

/**
 * Full (100% VO2max) gross aerobic power at a given altitude, W/kg —
 * altitude-adjusted but independent of the duration/LT2 curve. Used as the
 * reference for %VO2max intensity (which drives substrate partitioning),
 * as distinct from the pace-limiting `ceilingPower` below.
 */
export function maxAerobicPower(
  altitudeM: number,
  params: CeilingParams = {},
): number {
  const merged = { ...DEFAULTS, ...params };
  const availableVo2 = altitudeFraction(altitudeM) * merged.vo2MaxMlPerKgPerMin;
  return vo2ToPower(availableVo2, O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L);
}

/**
 * Gross aerobic power ceiling (W/kg) at a point in the event: duration-capped
 * fraction of VO2max, altitude-adjusted, with optional durability drift.
 */
export function ceilingPower(
  input: CeilingInput,
  params: CeilingParams = {},
): number {
  const merged = { ...DEFAULTS, ...params };
  const altitudeM = input.altitudeM ?? 0;
  const elapsedHours = input.elapsedHours ?? input.tMin / 60;

  const fraction = sustainableFraction(input.tMin, merged);
  const altFraction = altitudeFraction(altitudeM);
  const availableVo2 = fraction * altFraction * merged.vo2MaxMlPerKgPerMin;
  let power = vo2ToPower(availableVo2, O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L);

  if (merged.pacingCurveEnabled && merged.durabilityDriftPerHour > 0) {
    const driftFactor = Math.max(
      0,
      1 - merged.durabilityDriftPerHour * elapsedHours,
    );
    power *= driftFactor;
  }

  if (merged.pacingCurveEnabled && merged.durabilityDriftPerDescentUnit > 0 && input.descentExposure !== undefined) {
    const descentDriftFactor = Math.max(0, 1 - merged.durabilityDriftPerDescentUnit * input.descentExposure);
    power *= descentDriftFactor;
  }

  return power;
}
