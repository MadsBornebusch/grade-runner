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
 * Grade-adjusted pace (GAP): the flat-ground speed that would cost the same
 * energy per unit time as `speedMs` does at this segment's actual gradient
 * -- the standard "how fast does this effort feel on the flat" reading, in
 * the SAME gait the segment was actually covered in (a walked segment's GAP
 * uses costOfWalking throughout, not costOfRunning, so a walk break doesn't
 * read as an equivalent run pace it never was). Exactly `speedMs` on flat
 * ground by construction (cost(0)/cost(0) = 1).
 */
export function gradeAdjustedSpeedMs(speedMs: number, gradient: number, mode: "run" | "walk"): number {
  const cost = mode === "walk" ? costOfWalking : costOfRunning;
  const flatCost = cost(0);
  if (!(flatCost > 0)) return speedMs;
  return speedMs * (cost(gradient) / flatCost);
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
 * Grade at which the descent-control ramp BEGINS -- shallower than this,
 * still genuinely unlimited (a gentle downhill has no real control issue).
 * Real terrain oscillates across any single hard threshold constantly (a
 * technical descent's grade wanders back and forth through -8% to -12%
 * segment to segment), and the ONSET grade used to be that single
 * threshold: maxDescentSpeedMs jumped straight from Infinity to
 * DESCENT_LIMIT_SPEED_AT_ONSET_MS the instant grade crossed it, so a real
 * course crossing back and forth produced a predicted pace that slammed
 * between "uncapped, often fast" and "hard-capped ~6min/km" every other
 * segment -- a real, reported symptom, not a hypothetical one. Ramping
 * from here down to DESCENT_LIMIT_SPEED_AT_ONSET_MS at the onset grade
 * keeps the cap smooth exactly where real predicted paces (2-5 m/s) live,
 * without changing the calibrated onset anchor itself.
 */
const DESCENT_LIMIT_RAMP_START_GRADE = -0.04;

/** Cap at the ramp's start -- deliberately generous (comfortably faster
 * than realistic sustained trail-running speed, ~3:02/km) so it's not
 * really a new claimed limit, just a smooth approach into the one that
 * matters. Chosen for continuity, not a second calibration point. */
const DESCENT_LIMIT_SPEED_AT_RAMP_START_MS = 5.5;

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
 * No limit above the ramp-start grade (mild downhill is genuinely both
 * cheap and fast; the metabolic-cost model already governs there
 * correctly). Returns `Infinity` on flat/uphill. Smoothly ramps from the
 * ramp-start grade down to the onset grade (see
 * DESCENT_LIMIT_RAMP_START_GRADE's own doc for why this is two linear
 * pieces, not one step), then continues the original, separately
 * calibrated onset-to-clamp line unchanged.
 */
export function gradeOnlyMaxDescentSpeedMs(i: number): number {
  if (i >= DESCENT_LIMIT_RAMP_START_GRADE) return Infinity;
  if (i >= DESCENT_LIMIT_ONSET_GRADE) {
    const t = (i - DESCENT_LIMIT_RAMP_START_GRADE) / (DESCENT_LIMIT_ONSET_GRADE - DESCENT_LIMIT_RAMP_START_GRADE);
    return DESCENT_LIMIT_SPEED_AT_RAMP_START_MS + (DESCENT_LIMIT_SPEED_AT_ONSET_MS - DESCENT_LIMIT_SPEED_AT_RAMP_START_MS) * t;
  }
  const clamped = Math.max(-GRADE_CLAMP, i);
  const t = (clamped - DESCENT_LIMIT_ONSET_GRADE) / (-GRADE_CLAMP - DESCENT_LIMIT_ONSET_GRADE);
  return DESCENT_LIMIT_SPEED_AT_ONSET_MS + (DESCENT_LIMIT_SPEED_AT_CLAMP_MS - DESCENT_LIMIT_SPEED_AT_ONSET_MS) * t;
}

/**
 * (f0, fInf, tauKm) for descentPacingMultiplier below -- same
 * exponential-decay shape and naming convention as ceiling.ts's own
 * duration-decay fit (f0/fInf/tau), but over total race DISTANCE rather
 * than elapsed time. f0 is the multiplier approached at zero distance
 * (typically >1: descents run FASTER than the grade-only cap on a short
 * race), fInf the asymptote approached at ultra distance (typically <1),
 * tauKm the distance scale over which one decays to the other.
 */
export interface DescentPacingCurve {
  f0: number;
  fInf: number;
  tauKm: number;
}

/**
 * Default curve, used when this athlete has no fitted one of their own
 * (FormInputs.descentPacingCurve === null). Derived from ONE athlete's 8
 * real races (10.2km-171.4km, SSE=0.040) via
 * scripts/fitDescentPacingMultiplier.ts -- a real, data-informed starting
 * point, but emphatically that athlete's own descending behavior, not a
 * validated universal curve. Same epistemic status as
 * DESCENT_LIMIT_SPEED_AT_ONSET_MS above, and the reason
 * fitDescentPacingCurveAcrossRaces (pacingFit.ts) exists to replace it
 * per-athlete once a library has enough confirmed races to identify one.
 */
export const DEFAULT_DESCENT_PACING_CURVE: DescentPacingCurve = {
  f0: 1.23,
  fInf: 0.59,
  tauKm: 41,
};

/**
 * Scales gradeOnlyMaxDescentSpeedMs by how conservatively this athlete
 * actually paces descents, as a function of the RACE's total distance --
 * not a universal constant the way the grade-only cap above is treated.
 * Real GPS data (scripts/descentSpeedVsDistance.ts) shows this athlete runs
 * descents noticeably faster than that flat grade-only cap on a short race
 * (10.2km: 1.12x) and settles to roughly 55-60% of it by ultra distance
 * (113km: 0.57x, 171km: 0.58x) -- and critically, the effect is much
 * stronger BETWEEN races of different total distance (r=-0.79 to -0.84)
 * than WITHIN a single long race as distance-so-far accumulates (r=-0.20
 * to -0.36 across the three longest races checked). That asymmetry is why
 * this is keyed on total race distance (a pacing choice made for the
 * day, from the start) rather than cumulative distance run so far within
 * the simulation (which would model an in-race fatigue decay this
 * athlete's own data doesn't support nearly as strongly).
 *
 * Bounded to [curve.fInf, curve.f0] by construction (the exponential can't
 * overshoot either asymptote) -- deliberately NOT extrapolated further than
 * that for a hypothetical race shorter than the shortest one actually
 * observed, since there's no real data below that to support an even
 * larger boost.
 *
 * `curve` defaults to DEFAULT_DESCENT_PACING_CURVE (see its own doc on why
 * that's one athlete's numbers, not a universal constant); pass this
 * athlete's own fitted curve wherever one is available.
 */
export function descentPacingMultiplier(
  totalDistanceKm: number,
  curve: DescentPacingCurve = DEFAULT_DESCENT_PACING_CURVE,
): number {
  if (!(totalDistanceKm > 0)) return 1;
  return curve.fInf + (curve.f0 - curve.fInf) * Math.exp(-totalDistanceKm / curve.tauKm);
}

/**
 * Max running speed on a descent, independent of metabolic cost --
 * gradeOnlyMaxDescentSpeedMs's biomechanical/technical control shape,
 * scaled by descentPacingMultiplier when `totalDistanceKm` is given (the
 * race's total distance, known up front by any planning-mode caller).
 * Omitting it (analysis of a real recorded run, or any caller with no
 * whole-course context) keeps the original grade-only cap unchanged --
 * byte-for-byte identical to before this parameter existed. `curve`
 * likewise defaults to DEFAULT_DESCENT_PACING_CURVE when this athlete has
 * no fitted one.
 */
export function maxDescentSpeedMs(i: number, totalDistanceKm?: number, curve?: DescentPacingCurve): number {
  const cap = gradeOnlyMaxDescentSpeedMs(i);
  if (totalDistanceKm === undefined || !Number.isFinite(cap)) return cap;
  return cap * descentPacingMultiplier(totalDistanceKm, curve);
}
