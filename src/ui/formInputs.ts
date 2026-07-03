// Shared shape for the user-editable parameters in PLAN.md §7, persisted to
// localStorage so a returning user doesn't have to re-enter their physiology.

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
