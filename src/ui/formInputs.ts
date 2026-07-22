// Shared shape for the user-editable parameters in PLAN.md §7, persisted to
// localStorage so a returning user doesn't have to re-enter their physiology.

import type { CeilingParams } from "../model/ceiling";
import { maxAerobicPower } from "../model/ceiling";
import { fatOxPacePointToPowerFraction, fitCarbFractionAnchors, paceToGrossPowerWPerKg } from "../model/substrate";

export interface FatOxPoint {
  paceMinPerKm: number;
  fatGPerMin: number;
  carbGPerMin: number;
}

/** Rough confidence ordering, most to least certain -- see PLAN.md §12. */
export type Vo2MaxSource = "lab" | "race" | "wearable" | "manual";

export interface Vo2MaxEntry {
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  value: number;
  source: Vo2MaxSource;
}

export interface FormInputs {
  bodyMassKg: number;
  /** Dated, sourced measurements -- resolveVo2Max() combines them into the
   * single current value the ceiling model needs. Replaces a plain scalar
   * so a lab test can outweigh a watch guess, and old entries matter less
   * than recent ones as the athlete trains (PLAN.md §12). */
  vo2MaxHistory: Vo2MaxEntry[];
  lt1Fraction: number;
  lt2Fraction: number;
  /** Overrides lt1Fraction/lt2Fraction respectively when set, converting
   * pace into a %VO2max fraction via the same Minetti pace->power
   * conversion the fat-ox curve uses -- for athletes who know their
   * thresholds in pace terms rather than an abstract VO2max fraction. */
  lt1PaceMinPerKm: number | null;
  lt2PaceMinPerKm: number | null;
  /** Reference-only -- this app's ceiling model is power/pace-based, not
   * HR-based, so these aren't fed into any calculation. Captured purely so
   * an athlete entering pace-based thresholds can record the heart rate
   * they saw there too. */
  lt1HeartRateBpm: number | null;
  lt2HeartRateBpm: number | null;
  f0: number;
  fInf: number;
  tauMin: number;
  intakeGPerH: number;
  /** Glycogen store, expressed per kg body mass (not a raw gram total) --
   * see resolveGlycogenStoreG. */
  glycogenGPerKg: number;
  foPeakGPerMin: number;
  walkMaxMs: number;
  /** Grade fraction (e.g. 0.25 = 25%) above which walking is forced. Null = off. */
  forceWalkAboveGrade: number | null;
  altitudeAdjustment: boolean;
  /** Fraction lost per hour of durability drift. 0 = off. */
  durabilityDriftPerHour: number;
  /** Fraction lost per meter of unpaved/technical trail surface covered --
   * see src/model/surfaceExposure.ts. 0 = off (default; also the practical
   * value for any course/race with no surface data available yet). */
  durabilityDriftPerUnpavedUnit: number;
  segmentLengthM: number;
  smoothingWindowM: number;
  /** Measured (pace, fat-oxidation) points. Non-empty overrides LT1/LT2 for the fuel/substrate split. */
  fatOxPoints: FatOxPoint[];
  /** Display-only unit for the max walk speed field; the value is always stored as walkMaxMs. */
  walkSpeedDisplayUnit: "ms" | "kmh" | "minkm";
  /** Display-only unit for the fat-ox curve's pace column; points are always stored as paceMinPerKm. */
  fatOxSpeedDisplayUnit: "ms" | "kmh" | "minkm";
  /** Display-only unit for the fat-ox curve's fat/carb columns; points are always stored as g/min. */
  fatOxRateDisplayUnit: "gmin" | "ghour";
  /** Show the raw-vs-processed course debug chart. */
  showCourseDebug: boolean;
}

// Deliberately old so a genuinely new entry naturally outweighs it via
// recency once one is added -- see resolveVo2Max.
const DEFAULT_VO2MAX_DATE = "2020-01-01";

export const DEFAULT_FORM_INPUTS: FormInputs = {
  bodyMassKg: 70,
  vo2MaxHistory: [{ date: DEFAULT_VO2MAX_DATE, value: 50, source: "manual" }],
  lt1Fraction: 0.65,
  lt2Fraction: 0.85,
  lt1PaceMinPerKm: null,
  lt2PaceMinPerKm: null,
  lt1HeartRateBpm: null,
  lt2HeartRateBpm: null,
  f0: 0.94,
  fInf: 0.38,
  tauMin: 250,
  intakeGPerH: 60,
  // ~7-8 g/kg (liver + muscle glycogen) is a standard range for a fed,
  // trained endurance athlete -- see PLAN.md §5/§7. At the default 70kg body
  // mass this gives ~525g, close to this field's pre-g/kg default of 500g.
  glycogenGPerKg: 7.5,
  foPeakGPerMin: 0.55,
  walkMaxMs: 2.0,
  forceWalkAboveGrade: null,
  altitudeAdjustment: true,
  durabilityDriftPerHour: 0,
  durabilityDriftPerUnpavedUnit: 0,
  segmentLengthM: 50,
  smoothingWindowM: 150,
  fatOxPoints: [],
  walkSpeedDisplayUnit: "ms",
  fatOxSpeedDisplayUnit: "minkm",
  fatOxRateDisplayUnit: "gmin",
  showCourseDebug: false,
};

const STORAGE_KEY = "grade-runner:inputs";

export function loadFormInputs(): FormInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FORM_INPUTS;
    const parsed = JSON.parse(raw);
    const merged: FormInputs = { ...DEFAULT_FORM_INPUTS, ...parsed };
    // Migrate a pre-history save (a plain vo2MaxMlPerKgPerMin scalar, no
    // vo2MaxHistory yet) into a single manual entry dated today, so an
    // existing profile carries its current value forward instead of
    // silently reverting to the default.
    if (!parsed.vo2MaxHistory && typeof parsed.vo2MaxMlPerKgPerMin === "number") {
      merged.vo2MaxHistory = [
        { date: new Date().toISOString().slice(0, 10), value: parsed.vo2MaxMlPerKgPerMin, source: "manual" },
      ];
    }
    // Migrate a pre-g/kg save (a raw glycogenStoreG gram total, no
    // glycogenGPerKg yet) into the equivalent per-kg figure at that user's
    // own body mass, so a customized store carries forward instead of
    // silently reverting to the 7.5 g/kg default.
    if (!parsed.glycogenGPerKg && typeof parsed.glycogenStoreG === "number") {
      const bodyMassKg = typeof parsed.bodyMassKg === "number" ? parsed.bodyMassKg : DEFAULT_FORM_INPUTS.bodyMassKg;
      if (bodyMassKg > 0) merged.glycogenGPerKg = parsed.glycogenStoreG / bodyMassKg;
    }
    return merged;
  } catch {
    return DEFAULT_FORM_INPUTS;
  }
}

export function saveFormInputs(inputs: FormInputs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
}

/** Total glycogen store in grams, from the per-kg figure the UI collects. */
export function resolveGlycogenStoreG(inputs: Pick<FormInputs, "glycogenGPerKg" | "bodyMassKg">): number {
  return inputs.glycogenGPerKg * inputs.bodyMassKg;
}

/** Derives the substrate logistic anchors (x0, k) from LT1/LT2, per PLAN.md §5. */
export function substrateAnchorsFromThresholds(
  lt1Fraction: number,
  lt2Fraction: number,
): { x0: number; k: number } {
  return { x0: lt1Fraction, k: Math.log(9) / (lt2Fraction - lt1Fraction) };
}

// Fallback slope for a fitted fat-ox curve with only one point (no k to fit
// from), scaled down from the default %VO2max slope to absolute-power units
// via a nominal 50 ml/kg/min VO2max -- just needs to be a plausible order of
// magnitude, since a single point is inherently under-determined anyway.
const FALLBACK_ABSOLUTE_POWER_K =
  (Math.log(9) / (0.85 - 0.65)) / maxAerobicPower(0, { vo2MaxMlPerKgPerMin: 50 });

/**
 * Resolves the substrate params to actually use: the user's own fat-ox-vs-pace
 * curve if they've supplied one (fit directly in absolute power, no VO2max
 * needed), otherwise the LT1/LT2-derived %VO2max curve.
 */
export function resolveSubstrateAnchors(
  inputs: Pick<FormInputs, "lt1Fraction" | "lt2Fraction" | "fatOxPoints" | "walkMaxMs">,
): { x0: number; k: number; intensityIsAbsolutePower: boolean } {
  if (inputs.fatOxPoints.length > 0) {
    const points = inputs.fatOxPoints.map((p) =>
      fatOxPacePointToPowerFraction(p.paceMinPerKm, p.fatGPerMin, p.carbGPerMin, inputs.walkMaxMs),
    );
    const { x0, k } = fitCarbFractionAnchors(points, FALLBACK_ABSOLUTE_POWER_K);
    return { x0, k, intensityIsAbsolutePower: true };
  }
  const { x0, k } = substrateAnchorsFromThresholds(inputs.lt1Fraction, inputs.lt2Fraction);
  return { x0, k, intensityIsAbsolutePower: false };
}

/**
 * Converts a flat-ground pace into a %VO2max fraction, via the same
 * pace->gross-power conversion the fat-ox curve uses (see
 * `paceToGrossPowerWPerKg`), divided by the athlete's own aerobic ceiling
 * at sea level. Lets an athlete who knows their LT1/LT2 in pace terms enter
 * that directly instead of guessing an abstract %VO2max fraction. Same
 * flat-ground/gait-threshold assumptions as the fat-ox curve's pace
 * conversion.
 */
export function paceToVo2MaxFraction(
  paceMinPerKm: number,
  walkMaxMs: number,
  vo2MaxMlPerKgPerMin: number | undefined,
): number {
  const pGrossWPerKg = paceToGrossPowerWPerKg(paceMinPerKm, walkMaxMs);
  return pGrossWPerKg / maxAerobicPower(0, { vo2MaxMlPerKgPerMin });
}

// Rough SEE (standard error of estimate), ml/kg/min, per source -- inverse-
// variance weights in resolveVo2Max. Lab is treated as near-ground-truth;
// race-derived (an actual maximal 5k-marathon effort) SEE ~2-5 in validation
// studies; wearable is calibrated toward the well-trained-athlete end of its
// range, since that's who this app is for and accuracy is *worse* there, not
// better (a Forerunner 245 study found ~9-10% error in highly-trained
// runners vs ~3-4% in moderately-trained ones); manual is a wide guess.
// See PLAN.md §12.
const VO2MAX_SOURCE_SIGMA: Record<Vo2MaxSource, number> = {
  lab: 1,
  race: 3,
  wearable: 6,
  manual: 10,
};

// VO2max moves over a training macrocycle, not day to day -- independent
// constant from pacingFit.ts's tau-fit half-life (which tracks much faster
// week-to-week fatigue/durability changes).
const VO2MAX_RECENCY_HALF_LIFE_DAYS = 180;

/**
 * Combines dated, sourced VO2max measurements into the single current value
 * the ceiling model needs, via inverse-variance (by source confidence)
 * weighted by recency (older entries matter less, since VO2max genuinely
 * changes with training) -- see PLAN.md §12. Returns undefined on empty
 * history; CeilingParams.vo2MaxMlPerKgPerMin is already optional and
 * defaults to 50 internally, so callers can pass this straight through.
 */
export function resolveVo2Max(history: Vo2MaxEntry[], now: Date = new Date()): number | undefined {
  if (history.length === 0) return undefined;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const entry of history) {
    const daysAgo = Math.max(0, (now.getTime() - new Date(entry.date).getTime()) / 86_400_000);
    const recencyWeight = Math.exp((-Math.LN2 * daysAgo) / VO2MAX_RECENCY_HALF_LIFE_DAYS);
    const weight = recencyWeight / VO2MAX_SOURCE_SIGMA[entry.source] ** 2;
    weightedSum += weight * entry.value;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : undefined;
}

/**
 * Resolves LT1/LT2 as %VO2max fractions, honoring a pace-based override for
 * either threshold independently -- an athlete might know one in pace terms
 * and not the other. This sits *below* the fat-ox curve in the override
 * order: `resolveSubstrateAnchors` still overrides both entirely when
 * `fatOxPoints` is non-empty, regardless of what this returns. Also feeds
 * `ceilingParams.lt2Fraction` directly (the hard cap on sustainable
 * fraction), so both consumers of LT2 stay in sync with whichever
 * representation the athlete actually entered.
 */
export function resolveLt1Lt2Fractions(
  inputs: Pick<
    FormInputs,
    "lt1Fraction" | "lt2Fraction" | "lt1PaceMinPerKm" | "lt2PaceMinPerKm" | "walkMaxMs" | "vo2MaxHistory"
  >,
): { lt1Fraction: number; lt2Fraction: number } {
  const vo2Max = resolveVo2Max(inputs.vo2MaxHistory);
  const lt1Fraction =
    inputs.lt1PaceMinPerKm !== null
      ? paceToVo2MaxFraction(inputs.lt1PaceMinPerKm, inputs.walkMaxMs, vo2Max)
      : inputs.lt1Fraction;
  const lt2Fraction =
    inputs.lt2PaceMinPerKm !== null
      ? paceToVo2MaxFraction(inputs.lt2PaceMinPerKm, inputs.walkMaxMs, vo2Max)
      : inputs.lt2Fraction;
  return { lt1Fraction, lt2Fraction };
}

/**
 * Builds the `CeilingParams` every solver/analysis/diagnostic call site
 * needs, in one place -- previously duplicated as a near-identical object
 * literal at 8 call sites across App.tsx, RunLibraryPanel.tsx, and two
 * scripts, each of which had to remember to resolve VO2max and (now)
 * LT1/LT2 consistently.
 */
export function resolveCeilingParams(inputs: FormInputs): CeilingParams {
  const { lt2Fraction } = resolveLt1Lt2Fractions(inputs);
  return {
    vo2MaxMlPerKgPerMin: resolveVo2Max(inputs.vo2MaxHistory),
    lt2Fraction,
    f0: inputs.f0,
    fInf: inputs.fInf,
    tauMin: inputs.tauMin,
    durabilityDriftPerHour: inputs.durabilityDriftPerHour,
    durabilityDriftPerUnpavedUnit: inputs.durabilityDriftPerUnpavedUnit,
  };
}

/**
 * When a fat-ox curve is active (overriding LT1/LT2), expresses its fitted
 * crossover points -- in absolute W/kg, independent of VO2max -- as
 * equivalent %VO2max fractions, using the athlete's resolved VO2max purely
 * as a reference for comparison against the manual LT1/LT2 inputs it
 * replaces. This does NOT derive VO2max itself: a submaximal fat-ox test
 * alone can't tell us where the athlete's true ceiling is (that's exactly
 * the population-average assumption a personal curve is meant to avoid), so
 * VO2max still needs its own source and continues to set the pace ceiling
 * independently of this curve. Returns null when there's no curve, or the
 * resolved VO2max is non-positive (nothing to divide by).
 */
export function equivalentLT1LT2(
  inputs: Pick<FormInputs, "lt1Fraction" | "lt2Fraction" | "fatOxPoints" | "walkMaxMs" | "vo2MaxHistory">,
): { lt1Fraction: number; lt2Fraction: number } | null {
  if (inputs.fatOxPoints.length === 0) return null;
  const { x0, k } = resolveSubstrateAnchors(inputs);
  const seaLevelCeiling = maxAerobicPower(0, { vo2MaxMlPerKgPerMin: resolveVo2Max(inputs.vo2MaxHistory) });
  if (seaLevelCeiling <= 0) return null;
  return {
    lt1Fraction: x0 / seaLevelCeiling,
    lt2Fraction: (x0 + Math.log(9) / k) / seaLevelCeiling,
  };
}

/**
 * Suggests a fat-oxidation-peak ceiling from a fat-ox curve: the highest
 * fat-burning rate the user actually measured. Returns null with no points,
 * since there's nothing to derive it from.
 */
export function suggestedFoPeakGPerMin(points: FatOxPoint[]): number | null {
  if (points.length === 0) return null;
  return Math.max(...points.map((p) => p.fatGPerMin));
}

export type WalkSpeedUnit = FormInputs["walkSpeedDisplayUnit"];

/** Converts a walk speed from m/s into the given display unit. */
export function speedFromMs(ms: number, unit: WalkSpeedUnit): number {
  if (unit === "kmh") return ms * 3.6;
  if (unit === "minkm") return ms > 0 ? 1000 / (ms * 60) : 0;
  return ms;
}

/** Converts a walk speed from the given display unit back into m/s. */
export function speedToMs(value: number, unit: WalkSpeedUnit): number {
  if (unit === "kmh") return value / 3.6;
  if (unit === "minkm") return value > 0 ? 1000 / (value * 60) : 0;
  return value;
}

/** Converts a fat-ox curve pace (stored as min/km) into the given display unit. */
export function paceMinPerKmToDisplay(paceMinPerKm: number, unit: WalkSpeedUnit): number {
  if (unit === "minkm") return paceMinPerKm;
  const speedMs = paceMinPerKm > 0 ? 1000 / (paceMinPerKm * 60) : 0;
  return speedFromMs(speedMs, unit);
}

/** Converts a fat-ox curve pace from the given display unit back into min/km. */
export function displayToPaceMinPerKm(value: number, unit: WalkSpeedUnit): number {
  if (unit === "minkm") return value;
  const speedMs = speedToMs(value, unit);
  return speedMs > 0 ? 1000 / (speedMs * 60) : 0;
}

export type FatOxRateUnit = FormInputs["fatOxRateDisplayUnit"];

/** Converts a fat/carb oxidation rate (stored as g/min) into the given display unit. */
export function rateFromGPerMin(gPerMin: number, unit: FatOxRateUnit): number {
  return unit === "ghour" ? gPerMin * 60 : gPerMin;
}

/** Converts a fat/carb oxidation rate from the given display unit back into g/min. */
export function rateToGPerMin(value: number, unit: FatOxRateUnit): number {
  return unit === "ghour" ? value / 60 : value;
}
