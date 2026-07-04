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

/**
 * Gradient beyond which running speed on a descent starts being limited by
 * something other than metabolic cost. Matches where Cr(i) bottoms out
 * (PLAN.md §2) -- past this point Minetti's treadmill data (a controlled,
 * smooth, motor-imposed-speed protocol) has nothing to say about whether a
 * human can actually control their body at the speed their aerobic budget
 * would allow.
 */
const DESCENT_LIMIT_ONSET_GRADE = -0.1;

/**
 * Max controllable running speed right at the onset grade, m/s. Braking
 * (eccentric quad control), footing/balance, and technical terrain -- none
 * captured by Minetti -- cap real descending speed well below what a power
 * budget divided by Cr(i) implies, and it keeps getting more restrictive as
 * the descent steepens (PLAN.md §6 flags this as an "optional descent-fatigue
 * penalty... not captured by Minetti"; this is that penalty, expressed as a
 * speed limit rather than an energy cost so it doesn't distort the
 * metabolic/glycogen accounting used elsewhere, including Analysis mode).
 *
 * Roughly calibrated against one recorded 55km trail ultra's actual GPS pace
 * (median ~2.8 m/s at -10%, decaying to ~1.0 m/s by -45%) -- a real but
 * single, noisy data point, not a validated constant like Minetti's own
 * curve. Treat as a reasonable default, not a precise universal figure.
 */
const DESCENT_LIMIT_SPEED_AT_ONSET_MS = 2.8;

/** Max controllable running speed at the steepest clamped grade, m/s. */
const DESCENT_LIMIT_SPEED_AT_CLAMP_MS = 1.0;

/**
 * Max running speed on a descent, independent of metabolic cost -- reflects
 * biomechanical/technical control limits rather than energy availability.
 * No limit above the onset grade (mild downhill is genuinely both cheap and
 * fast; the metabolic-cost model already governs there correctly). Returns
 * `Infinity` on flat/uphill.
 */
export function maxDescentSpeedMs(i: number): number {
  if (i >= DESCENT_LIMIT_ONSET_GRADE) return Infinity;
  const clamped = Math.max(-GRADE_CLAMP, i);
  const t = (clamped - DESCENT_LIMIT_ONSET_GRADE) / (-GRADE_CLAMP - DESCENT_LIMIT_ONSET_GRADE);
  return DESCENT_LIMIT_SPEED_AT_ONSET_MS + (DESCENT_LIMIT_SPEED_AT_CLAMP_MS - DESCENT_LIMIT_SPEED_AT_ONSET_MS) * t;
}
