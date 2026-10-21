// The athlete's own numbers for the ad hoc scripts (body mass, VO2max,
// thresholds, a lab test, values the app reported as applied), kept in the
// gitignored athlete.local.json at the repo root so none of it is
// committed. Without the file the scripts fall back to the app's generic
// defaults and say so.
//
// athlete.local.json:
//   { "form": Partial<FormInputs>,           // e.g. bodyMassKg, vo2MaxHistory, lt2PaceMinPerKm
//     "fitted": { [script]: {...} },          // per-script reported values, optional
//     "labTest": { "stages": LabStage[], ... } }  // optional
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { DEFAULT_FORM_INPUTS, resolveLt1Lt2Fractions, resolveVo2Max, type FatOxPoint, type FormInputs } from "../src/ui/formInputs.ts";

const PROFILE_PATH = fileURLToPath(new URL("../athlete.local.json", import.meta.url));

export interface LabStage {
  speedKmh: number;
  rer: number;
  heartRateBpm: number;
  vo2LPerMin: number;
  fatGPerMin: number;
  carbGPerMin: number;
}

export interface AthleteProfile {
  form: FormInputs;
  fitted: Record<string, Record<string, number>>;
  labStages: LabStage[];
  fromFile: boolean;
}

let cached: AthleteProfile | null = null;

export function loadAthleteProfile(): AthleteProfile {
  if (cached) return cached;
  if (!existsSync(PROFILE_PATH)) {
    console.warn("athlete.local.json not found: using the app's generic defaults (70 kg, VO2max 50, LT2 0.85)");
    cached = { form: DEFAULT_FORM_INPUTS, fitted: {}, labStages: [], fromFile: false };
    return cached;
  }
  const raw = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as {
    form?: Partial<FormInputs>; fitted?: Record<string, Record<string, number>>; labTest?: { stages?: LabStage[] };
  };
  const fitted = Object.fromEntries(Object.entries(raw.fitted ?? {}).filter(([, v]) => typeof v === "object"));
  cached = { form: { ...DEFAULT_FORM_INPUTS, ...raw.form }, fitted, labStages: raw.labTest?.stages ?? [], fromFile: true };
  return cached;
}

/** VO2max and LT2 only, the pair most scripts pass to analyzeRun. */
export function athleteCeilingParams(profile = loadAthleteProfile()): Pick<CeilingParams, "vo2MaxMlPerKgPerMin" | "lt2Fraction"> {
  return { vo2MaxMlPerKgPerMin: resolveVo2Max(profile.form.vo2MaxHistory), lt2Fraction: resolveLt1Lt2Fractions(profile.form).lt2Fraction };
}

/** A per-script reported value, or `fallback` without one. */
export function fittedValue(script: string, key: string, fallback: number): number {
  return loadAthleteProfile().fitted[script]?.[key] ?? fallback;
}

export function labFatOxPoints(profile = loadAthleteProfile()): FatOxPoint[] {
  return profile.labStages.map((s) => ({ paceMinPerKm: 60 / s.speedKmh, heartRateBpm: s.heartRateBpm, fatGPerMin: s.fatGPerMin, carbGPerMin: s.carbGPerMin }));
}
