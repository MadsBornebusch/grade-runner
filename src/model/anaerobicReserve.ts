// Bounded, prediction-only anaerobic capacity above LT2 for short events.
// See PLAN.md's own note on why sustainableFraction's Math.min(fraction,
// lt2Fraction) cap is load-bearing for the tau/fInf fit (pacingFit.ts) and
// must never be touched -- this file exists specifically to give short
// predictions genuine above-LT2 effort WITHOUT going anywhere near that
// cap or the fitting pipeline that depends on it. Nothing here is
// imported by pacingFit.ts, hrCalibration.ts, or workAccumulation.ts, and
// this file never imports from them -- same isolation discipline those
// three already use for DEFAULT_LT2_FRACTION (restated locally in each,
// not shared), applied here for the same reason: staying decoupled from
// ceiling.ts's exported sustainableFraction/ceilingPower keeps this
// mechanism structurally incapable of affecting a fit, not just carefully
// not-called from one.
//
// Deliberately monotonic (spend, never recover) -- a real W'-balance model
// (spend on a climb, recover on the descent, spend again) was considered
// and set aside: the motivating report was duration-based (a short race
// predicting nearly the same effort as one twice as long), not about
// mid-race surge-and-recover, so a one-time depleting reserve is the
// right level of complexity here.

import { maxAerobicPower, type CeilingParams } from "./ceiling";

// Mirrors ceiling.ts's own DEFAULTS -- restated here rather than imported,
// see this file's header doc for why.
const DEFAULT_F0 = 0.94;
const DEFAULT_FINF = 0.38;
const DEFAULT_TAU_MIN = 250;
const DEFAULT_LT2_FRACTION = 0.85;

/** Same exponential shape as ceiling.ts's sustainableFraction, WITHOUT the
 * Math.min(fraction, lt2Fraction) cap -- the whole point of this file. */
function rawSustainableFraction(tMin: number, params: CeilingParams): number {
  const f0 = params.f0 ?? DEFAULT_F0;
  const fInf = params.fInf ?? DEFAULT_FINF;
  const tauMin = params.tauMin ?? DEFAULT_TAU_MIN;
  if (params.pacingCurveEnabled === false) return f0;
  return fInf + (f0 - fInf) * Math.exp(-tMin / tauMin);
}

/**
 * Closed-form duration (minutes) at which the raw (uncapped) curve decays
 * back down to lt2Fraction -- past this point there's nothing above the
 * cap left to draw on, for ANY duration-based prediction, regardless of
 * how much reserve remains. 0 (mechanism inert) when the pacing curve is
 * disabled (no decay to reason about at all) or when f0 doesn't exceed
 * lt2Fraction for this athlete's params in the first place (nothing above
 * the cap even at t=0).
 *
 * This is also the basis for the long-race guarantee in solver.ts: a race
 * whose own predicted duration exceeds this crossover gets the reserve
 * stripped entirely before its "real" solve, so its result is byte-
 * identical to not having a reserve configured at all -- not just a small
 * numerical difference, an exact match.
 */
export function reserveCrossoverMin(ceilingParams: CeilingParams): number {
  if (ceilingParams.pacingCurveEnabled === false) return 0;
  const f0 = ceilingParams.f0 ?? DEFAULT_F0;
  const fInf = ceilingParams.fInf ?? DEFAULT_FINF;
  const tauMin = ceilingParams.tauMin ?? DEFAULT_TAU_MIN;
  const lt2Fraction = ceilingParams.lt2Fraction ?? DEFAULT_LT2_FRACTION;
  if (f0 <= lt2Fraction) return 0;
  const ratio = (lt2Fraction - fInf) / (f0 - fInf);
  if (!(ratio > 0) || ratio >= 1) return 0;
  return -tauMin * Math.log(ratio);
}

export interface AnaerobicReserveParams {
  /** Total extra work available above the LT2-capped ceiling, kJ/kg --
   * per-kg convention matching this app's other athlete-mass-normalized
   * power quantities (e.g. grossPowerWPerKg). Analogous to W' in
   * critical-power literature: a 70kg runner's real-world W' is typically
   * ~15-30kJ total, i.e. ~0.2-0.4 kJ/kg. */
  reserveKJPerKg: number;
}

export interface AnaerobicReserveState {
  consumedKJPerKg: number;
}

/**
 * Extra gross power (W/kg) available above the LT2-capped ceiling at this
 * instant -- 0 once the reserve is exhausted, OR once the raw curve has
 * already decayed to/below lt2Fraction (nothing left above the cap to draw
 * on, regardless of remaining reserve). Reuses ceiling.ts's
 * maxAerobicPower directly (already the reference every other power
 * quantity in this app is built from, and independent of the LT2 cap, so
 * importing it doesn't reopen the fitting-isolation concern this file
 * otherwise avoids).
 */
export function availableReserveBoostWPerKg(
  tMin: number,
  altitudeM: number,
  ceilingParams: CeilingParams,
  reserveState: AnaerobicReserveState,
  reserveParams: AnaerobicReserveParams,
): number {
  if (reserveState.consumedKJPerKg >= reserveParams.reserveKJPerKg) return 0;
  const lt2Fraction = ceilingParams.lt2Fraction ?? DEFAULT_LT2_FRACTION;
  const rawFraction = rawSustainableFraction(tMin, ceilingParams);
  const boostFraction = Math.max(0, rawFraction - lt2Fraction);
  if (boostFraction <= 0) return 0;
  return boostFraction * maxAerobicPower(altitudeM, ceilingParams);
}

/**
 * Saturating accumulator, same shape as substrate.ts's stepGlycogen but
 * clamped at a ceiling instead of a floor (consumedKJPerKg only ever
 * increases, capped at reserveKJPerKg -- once spent, spent for the rest of
 * this simulation).
 */
export function stepAnaerobicReserve(
  state: AnaerobicReserveState,
  boostDrawnWPerKg: number,
  dtSeconds: number,
  reserveParams: AnaerobicReserveParams,
): AnaerobicReserveState {
  const consumedKJPerKg = Math.min(
    reserveParams.reserveKJPerKg,
    state.consumedKJPerKg + (boostDrawnWPerKg * dtSeconds) / 1000,
  );
  return { consumedKJPerKg };
}
