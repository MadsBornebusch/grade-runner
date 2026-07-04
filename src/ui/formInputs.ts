// Shared shape for the user-editable parameters in PLAN.md §7, persisted to
// localStorage so a returning user doesn't have to re-enter their physiology.

import { maxAerobicPower } from "../model/ceiling";
import { fatOxPacePointToPowerFraction, fitCarbFractionAnchors } from "../model/substrate";

export interface FatOxPoint {
  paceMinPerKm: number;
  fatGPerMin: number;
  carbGPerMin: number;
}

export interface FormInputs {
  bodyMassKg: number;
  vo2MaxMlPerKgPerMin: number;
  lt1Fraction: number;
  lt2Fraction: number;
  f0: number;
  fInf: number;
  tauMin: number;
  intakeGPerH: number;
  gutMaxGPerH: number;
  glycogenStoreG: number;
  reserveG: number;
  foPeakGPerMin: number;
  walkMaxMs: number;
  /** Grade fraction (e.g. 0.25 = 25%) above which walking is forced. Null = off. */
  forceWalkAboveGrade: number | null;
  altitudeAdjustment: boolean;
  /** Fraction lost per hour of durability drift. 0 = off. */
  durabilityDriftPerHour: number;
  segmentLengthM: number;
  smoothingWindowM: number;
  /** Measured (pace, fat-oxidation) points. Non-empty overrides LT1/LT2 for the fuel/substrate split. */
  fatOxPoints: FatOxPoint[];
  /** Display-only unit for the max walk speed field; the value is always stored as walkMaxMs. */
  walkSpeedDisplayUnit: "ms" | "kmh" | "minkm";
}

export const DEFAULT_FORM_INPUTS: FormInputs = {
  bodyMassKg: 70,
  vo2MaxMlPerKgPerMin: 50,
  lt1Fraction: 0.65,
  lt2Fraction: 0.85,
  f0: 0.94,
  fInf: 0.38,
  tauMin: 250,
  intakeGPerH: 60,
  gutMaxGPerH: 60,
  glycogenStoreG: 500,
  reserveG: 60,
  foPeakGPerMin: 0.55,
  walkMaxMs: 2.0,
  forceWalkAboveGrade: null,
  altitudeAdjustment: true,
  durabilityDriftPerHour: 0,
  segmentLengthM: 50,
  smoothingWindowM: 40,
  fatOxPoints: [],
  walkSpeedDisplayUnit: "ms",
};

const STORAGE_KEY = "grade-runner:inputs";

export function loadFormInputs(): FormInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FORM_INPUTS;
    return { ...DEFAULT_FORM_INPUTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FORM_INPUTS;
  }
}

export function saveFormInputs(inputs: FormInputs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
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
