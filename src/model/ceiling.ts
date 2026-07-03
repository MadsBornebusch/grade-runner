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
}

const DEFAULTS: Required<CeilingParams> = {
  vo2MaxMlPerKgPerMin: 50,
  lt2Fraction: 0.85,
  f0: 0.94,
  fInf: 0.38,
  tauMin: 250,
  durabilityDriftPerHour: 0,
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

  return power;
}
