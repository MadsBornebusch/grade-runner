// Energy cost of locomotion vs. gradient, from Minetti et al. 2002 (J Appl
// Physiol 93:1039-1046). Gradient `i` is dimensionless: rise / horizontal-run.
// Cost is in J·kg⁻¹·m⁻¹ of along-slope (belt) distance — see PLAN.md §5
// "Distance convention".

/** Gradient magnitude beyond which the fitted polynomials are no longer valid. */
export const GRADE_CLAMP = 0.45;

/**
 * Extra energy cost per vertical meter climbed, applied beyond GRADE_CLAMP.
 * ≈ 9.81 (J/kg per vertical m at 100% mechanical efficiency) / 0.25 (assumed
 * efficiency of very steep climbing) ≈ 39.24 J/kg/m. Without this, the raw
 * quintic fit diverges/flat-lines outside its validated range instead of
 * continuing to get more expensive as pitches steepen (PLAN.md §5, P1).
 */
export const VERTICAL_COST_PER_M = 9.81 / 0.25;

function runningPolynomial(i: number): number {
  return (
    155.4 * i ** 5 -
    30.4 * i ** 4 -
    43.3 * i ** 3 +
    46.3 * i ** 2 +
    19.5 * i +
    3.6
  );
}

function walkingPolynomial(i: number): number {
  return (
    280.5 * i ** 5 -
    58.7 * i ** 4 -
    76.8 * i ** 3 +
    51.9 * i ** 2 +
    19.6 * i +
    2.5
  );
}

/**
 * Extra cost (J/kg per along-slope meter) for climbing steeper than the
 * clamp. Approximates the additional vertical rise per slope-meter gained by
 * exceeding the clamp gradient, priced at VERTICAL_COST_PER_M. Only applied
 * uphill — steep sustained descents beyond -45% are rare on real courses and
 * Minetti's data gives no basis for extrapolating braking cost there, so
 * downhill is simply clamped.
 */
function steepClimbSurcharge(i: number): number {
  if (i <= GRADE_CLAMP) return 0;
  const extraVerticalPerSlopeMeter = (i - GRADE_CLAMP) / Math.sqrt(1 + i * i);
  return extraVerticalPerSlopeMeter * VERTICAL_COST_PER_M;
}

/** Energy cost of running at gradient `i` (J·kg⁻¹ per along-slope meter). */
export function costOfRunning(i: number): number {
  const clamped = Math.max(-GRADE_CLAMP, Math.min(GRADE_CLAMP, i));
  return runningPolynomial(clamped) + steepClimbSurcharge(i);
}

/** Energy cost of walking at gradient `i` (J·kg⁻¹ per along-slope meter). */
export function costOfWalking(i: number): number {
  const clamped = Math.max(-GRADE_CLAMP, Math.min(GRADE_CLAMP, i));
  return walkingPolynomial(clamped) + steepClimbSurcharge(i);
}
