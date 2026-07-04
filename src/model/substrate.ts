// Carbohydrate/fat substrate split and glycogen/gut fuel simulation.
// See PLAN.md §5 "Fat oxidation — energy-conserving default (P1)" and
// "Fuel = reservoir + flow limit, in grams".

import { CARB_KJ_PER_G, FAT_KJ_PER_G, netToGross } from "./energetics";
import { costOfRunning, costOfWalking } from "./minetti";

export interface SubstrateParams {
  /** Anchor: intensity at which carb fraction = 0.5. Default LT1 = 0.65 (%VO2max). */
  x0?: number;
  /** Logistic slope. Default ln(9)/(LT2-LT1) so fraction reaches 0.9 at LT2 = 0.85. */
  k?: number;
  /** Absolute fat oxidation rate ceiling, g/min. Default 0.55, ~1.0 for elites. */
  foPeakGPerMin?: number;
  /**
   * If true, `x0`/`k` (and the `x` callers pass to carbEnergyFraction/splitPower)
   * are in absolute gross power (W/kg) rather than %VO2max — set when the
   * anchors came from a user's own fat-ox-vs-pace curve rather than
   * LT1/LT2 fractions. Trade-off: skips the per-segment Cerretelli altitude
   * adjustment for the substrate split specifically (the aerobic ceiling
   * remains fully altitude-aware regardless) since there's no VO2max to
   * adjust. A secondary-order effect for most courses.
   */
  intensityIsAbsolutePower?: boolean;
}

const DEFAULT_LT1 = 0.65;
const DEFAULT_LT2 = 0.85;
const DEFAULT_X0 = DEFAULT_LT1;
const DEFAULT_K = Math.log(9) / (DEFAULT_LT2 - DEFAULT_LT1);
const DEFAULT_FO_PEAK_G_PER_MIN = 0.55;

function resolveParams(params: SubstrateParams) {
  return {
    x0: params.x0 ?? DEFAULT_X0,
    k: params.k ?? DEFAULT_K,
    foPeakGPerMin: params.foPeakGPerMin ?? DEFAULT_FO_PEAK_G_PER_MIN,
  };
}

/** Carbohydrate energy fraction at intensity `x` (fraction of VO2max, e.g. 0.65 = 65%). */
export function carbEnergyFraction(x: number, params: SubstrateParams = {}): number {
  const { x0, k } = resolveParams(params);
  return 1 / (1 + Math.exp(-k * (x - x0)));
}

/**
 * Fits logistic anchors (x0, k) to measured (intensity, carb-fraction) points
 * via linear regression on the logit scale: logit(fC) = k*x - k*x0 is linear
 * in x, so this reduces to ordinary least squares rather than a nonlinear fit.
 * With a single point, `k` is held at its default and only `x0` is solved
 * (PLAN.md §5: "1-2 pts -> shift/scale the default logistic").
 */
export function fitCarbFractionAnchors(
  points: Array<{ x: number; fC: number }>,
  defaultK: number = DEFAULT_K,
): { x0: number; k: number } {
  if (points.length === 0) throw new Error("fitCarbFractionAnchors: need at least one point");

  // Clamp away from 0/1: real measured points can legitimately land at an
  // exact substrate extreme (e.g. ~0 fat oxidation at max effort), which
  // would otherwise send the logit to +/-Infinity and poison the fit with NaN.
  const EPSILON = 1e-6;
  const z = points.map((p) => {
    const fC = Math.min(1 - EPSILON, Math.max(EPSILON, p.fC));
    return Math.log(fC / (1 - fC));
  });

  if (points.length === 1) {
    return { x0: points[0].x - z[0] / defaultK, k: defaultK };
  }

  const n = points.length;
  const xs = points.map((p) => p.x);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanZ = z.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (z[i] - meanZ);
    den += (xs[i] - meanX) ** 2;
  }
  const k = num / den;
  const x0 = meanX - meanZ / k;
  return { x0, k };
}

/**
 * Converts a measured (intensity, fat-oxidation) data point into an
 * (x, carb-energy-fraction) point suitable for `fitCarbFractionAnchors`.
 * `fatGPerMin` is whole-body (not per-kg) fat oxidation, as reported by
 * metabolic carts; `pGrossWPerKg` is the gross metabolic power at that
 * intensity.
 */
export function fatOxPointToFraction(
  intensityFraction: number,
  fatGPerMin: number,
  pGrossWPerKg: number,
  bodyMassKg: number,
): { x: number; fC: number } {
  const fatRateWPerKg = ((fatGPerMin / 60) * FAT_KJ_PER_G * 1000) / bodyMassKg;
  const fatFraction = fatRateWPerKg / pGrossWPerKg;
  return { x: intensityFraction, fC: 1 - fatFraction };
}

/**
 * Converts a (pace, fat-ox, carb-ox) calibration point measured on flat
 * ground into a (gross power, carb-energy-fraction) pair, in absolute W/kg
 * rather than %VO2max — for users who have their own fat/carb-oxidation-vs-pace
 * data and don't know their VO2max. `fC` is computed as a ratio of the two
 * measured oxidation rates directly (mass cancels, so neither needs body
 * mass), rather than comparing measured fat against Minetti's *assumed*
 * gross power for that pace — the latter can disagree with the metabolic
 * cart enough to push fC outside (0,1) and blow up the logistic fit. `x`
 * (the intensity axis) still comes from the Minetti pace->power conversion,
 * since that's what the simulation itself uses as its intensity axis.
 * Assumes the test was run on a flat treadmill (the usual protocol) and that
 * walking vs. running gait follows the same speed threshold as everywhere
 * else in the model.
 */
export function fatOxPacePointToPowerFraction(
  paceMinPerKm: number,
  fatGPerMin: number,
  carbGPerMin: number,
  walkMaxMs = 2.0,
): { x: number; fC: number } {
  const speedMs = 1000 / (paceMinPerKm * 60);
  const cost = speedMs <= walkMaxMs ? costOfWalking(0) : costOfRunning(0);
  const pGrossWPerKg = netToGross(cost * speedMs);
  const fatKJPerMin = fatGPerMin * FAT_KJ_PER_G;
  const carbKJPerMin = carbGPerMin * CARB_KJ_PER_G;
  const totalKJPerMin = fatKJPerMin + carbKJPerMin;
  const fC = totalKJPerMin > 0 ? carbKJPerMin / totalKJPerMin : 0.5;
  return { x: pGrossWPerKg, fC };
}

function fatCeilingWPerKg(foPeakGPerMin: number, bodyMassKg: number): number {
  return ((foPeakGPerMin / 60) * FAT_KJ_PER_G * 1000) / bodyMassKg;
}

export interface SplitResult {
  carbRateWPerKg: number;
  fatRateWPerKg: number;
  /** True if the fat-rate ceiling was hit and the shortfall was forced onto carbs. */
  fatCapped: boolean;
}

/**
 * Splits gross metabolic power into carb/fat rates at intensity `x`,
 * enforcing the absolute fat-oxidation ceiling. Conserves energy by
 * construction: carbRateWPerKg + fatRateWPerKg === pGrossWPerKg always.
 */
export function splitPower(
  pGrossWPerKg: number,
  x: number,
  bodyMassKg: number,
  params: SubstrateParams = {},
): SplitResult {
  const { foPeakGPerMin } = resolveParams(params);
  const fC = carbEnergyFraction(x, params);
  const uncappedFatRate = (1 - fC) * pGrossWPerKg;
  const ceiling = fatCeilingWPerKg(foPeakGPerMin, bodyMassKg);

  const fatCapped = uncappedFatRate > ceiling;
  const fatRateWPerKg = fatCapped ? ceiling : uncappedFatRate;
  const carbRateWPerKg = pGrossWPerKg - fatRateWPerKg;

  return { carbRateWPerKg, fatRateWPerKg, fatCapped };
}

export interface FuelingParams {
  /** Planned exogenous carb intake, g/h. */
  intakeGPerH: number;
  /** Gut oxidation ceiling, g/h (~60 glucose-only, ~90 glucose+fructose). */
  gutMaxGPerH: number;
}

export interface GlycogenState {
  glycogenG: number;
}

/**
 * Advances the glycogen reservoir by `dtSeconds`, given the current carb
 * demand and the gut-limited exogenous carb supply. Floored at `reserveG` —
 * the caller (solver) is responsible for detecting the reserve floor and
 * collapsing achievable power to `bonkPowerWPerKg`.
 */
export function stepGlycogen(
  state: GlycogenState,
  carbRateWPerKg: number,
  bodyMassKg: number,
  fueling: FuelingParams,
  dtSeconds: number,
  reserveG = 60,
): GlycogenState {
  const carbDemandGPerS =
    (carbRateWPerKg * bodyMassKg) / (CARB_KJ_PER_G * 1000);
  const carbInOxGPerS = Math.min(fueling.intakeGPerH, fueling.gutMaxGPerH) / 3600;
  const deltaG = (carbInOxGPerS - carbDemandGPerS) * dtSeconds;
  return { glycogenG: Math.max(reserveG, state.glycogenG + deltaG) };
}

/**
 * Sustainable power once glycogen has bottomed out: fat oxidation at its
 * ceiling plus whatever exogenous carb the gut can still supply.
 */
export function bonkPowerWPerKg(
  bodyMassKg: number,
  fueling: FuelingParams,
  params: SubstrateParams = {},
): number {
  const { foPeakGPerMin } = resolveParams(params);
  const carbInOxGPerS = Math.min(fueling.intakeGPerH, fueling.gutMaxGPerH) / 3600;
  const carbInOxWPerKg = (carbInOxGPerS * CARB_KJ_PER_G * 1000) / bodyMassKg;
  return fatCeilingWPerKg(foPeakGPerMin, bodyMassKg) + carbInOxWPerKg;
}
