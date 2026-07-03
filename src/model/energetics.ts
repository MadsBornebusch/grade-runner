// Unit conversions and net/gross bookkeeping shared by the rest of the
// model. See PLAN.md §2 and §5 "P0 corrections" / "Other P1/P2 corrections".

/** Resting metabolic power, W/kg. Bridges Minetti's *net* cost to *gross*
 * (VO2max-referenced) power: P_gross = Cr(i)·v + P_rest. */
export const RESTING_METABOLISM_W_PER_KG = 1.2;

/** Energy yielded per liter of O2 consumed oxidizing carbohydrate (RER 0.96). */
export const O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L = 20.9;
/** Energy yielded per liter of O2 consumed oxidizing fat. */
export const O2_ENERGY_EQUIVALENT_FAT_KJ_PER_L = 19.6;

/** Energy density of carbohydrate and fat, used for gram <-> Joule bookkeeping. */
export const CARB_KJ_PER_G = 16.7;
export const FAT_KJ_PER_G = 37.7;

/** 1 MET, in ml O2 per kg body mass per minute. */
export const MET_VO2_ML_PER_KG_PER_MIN = 3.5;

/** Converts a VO2 rate (ml O2 · kg⁻¹ · min⁻¹) to metabolic power (W/kg). */
export function vo2ToPower(
  vo2MlPerKgPerMin: number,
  kJPerLO2: number = O2_ENERGY_EQUIVALENT_CARB_KJ_PER_L,
): number {
  // (ml/min -> L/min) * kJ/L * (1000 J/kJ) / (60 s/min) == vo2 * kJPerLO2 / 60
  return (vo2MlPerKgPerMin * kJPerLO2) / 60;
}

/** Adds resting metabolism to a net (locomotion-only) power to get gross power, both W/kg. */
export function netToGross(netPowerWPerKg: number): number {
  return netPowerWPerKg + RESTING_METABOLISM_W_PER_KG;
}

/** Subtracts resting metabolism from a gross power to get net (locomotion-only) power, both W/kg. */
export function grossToNet(grossPowerWPerKg: number): number {
  return grossPowerWPerKg - RESTING_METABOLISM_W_PER_KG;
}

/**
 * Gross metabolic power (W/kg) for moving at `speedMs` at a Minetti cost of
 * `costJPerKgPerM` (J·kg⁻¹ per along-slope meter): net locomotion power
 * (cost * speed) plus resting metabolism.
 */
export function grossMetabolicPower(
  costJPerKgPerM: number,
  speedMs: number,
): number {
  return netToGross(costJPerKgPerM * speedMs);
}

/** Converts a mass in grams of a substrate to Joules of energy, given its energy density (kJ/g). */
export function gramsToJoules(grams: number, kJPerG: number): number {
  return grams * kJPerG * 1000;
}

/** Converts Joules of energy to a mass in grams of a substrate, given its energy density (kJ/g). */
export function joulesToGrams(joules: number, kJPerG: number): number {
  return joules / (kJPerG * 1000);
}
