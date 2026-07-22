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
   * A third, independent durability term keyed to cumulative unpaved/
   * technical-trail distance covered (see CeilingInput.unpavedExposureM and
   * src/model/surfaceExposure.ts) -- terrain difficulty the grade/altitude
   * model alone doesn't capture. Validated with a leave-one-out backtest
   * across 31 real races: adding a fitted rate here improved held-out
   * finish-time prediction on 28, regressed 0, left unchanged the ones with
   * ~no unpaved terrain. Fraction lost per unpaved meter. 0 = off (default).
   * Composes multiplicatively with the other two drift terms, same as they
   * already compose with each other.
   */
  durabilityDriftPerUnpavedUnit?: number;
}

const DEFAULTS: Required<CeilingParams> = {
  vo2MaxMlPerKgPerMin: 50,
  lt2Fraction: 0.85,
  f0: 0.94,
  fInf: 0.38,
  tauMin: 250,
  durabilityDriftPerHour: 0,
  durabilityDriftPerDescentUnit: 0,
  durabilityDriftPerUnpavedUnit: 0,
};

/**
 * Sustainable fraction of VO2max as a function of event duration so far,
 * minutes. Bounded decay (replaces Saltin's `(940-t)/1000`, which goes
 * negative past ~15.6h) always capped by LT2.
 */
export function sustainableFraction(
  tMin: number,
  params: CeilingParams = {},
): number {
  const { f0, fInf, tauMin, lt2Fraction } = { ...DEFAULTS, ...params };
  const fraction = fInf + (f0 - fInf) * Math.exp(-tMin / tauMin);
  return Math.min(fraction, lt2Fraction);
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
  /**
   * Cumulative unpaved/technical-trail distance covered so far, meters (see
   * src/model/surfaceExposure.ts) -- drives the optional
   * durabilityDriftPerUnpavedUnit term. Undefined (the default) means no
   * surface data is available for this course, regardless of
   * durabilityDriftPerUnpavedUnit -- distinct from 0 ("known, genuinely no
   * unpaved distance yet"), same contract as descentExposure.
   */
  unpavedExposureM?: number;
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

  if (merged.durabilityDriftPerHour > 0) {
    const driftFactor = Math.max(
      0,
      1 - merged.durabilityDriftPerHour * elapsedHours,
    );
    power *= driftFactor;
  }

  if (merged.durabilityDriftPerDescentUnit > 0 && input.descentExposure !== undefined) {
    const descentDriftFactor = Math.max(0, 1 - merged.durabilityDriftPerDescentUnit * input.descentExposure);
    power *= descentDriftFactor;
  }

  if (merged.durabilityDriftPerUnpavedUnit > 0 && input.unpavedExposureM !== undefined) {
    const surfaceDriftFactor = Math.max(0, 1 - merged.durabilityDriftPerUnpavedUnit * input.unpavedExposureM);
    power *= surfaceDriftFactor;
  }

  return power;
}
