// PLAN.md §14 Plan B, HR-prediction-quality follow-up: measures the thing
// that actually matters for the shipped "Estimated HR" feature -- mean
// absolute error in bpm between predicted and actual heart rate -- rather
// than pooled R^2 (which can look better after filtering short races
// without the underlying per-split estimate actually moving; see
// scripts/diagnoseHrCalibration.ts, where predicted HR sat at 147-150bpm
// across every duration floor tested despite R^2 tripling).
//
// For each long race with heart rate (Ecotrail 80, Soria Moria), fits the
// HR calibration TWICE, leave-one-out (excluding the race being
// evaluated, so there's no leakage): once on the full activity pool
// (today's production behavior) and once restricted to a duration floor
// (the candidate fix). Predicts heart rate per 30-min bin from each
// calibration and compares to the bin's own actual mean HR -- reports
// MAE and signed bias for both, so filtering only "wins" if it actually
// reduces real bpm error, not just tightens R^2.
//
// Usage: npx tsx scripts/evaluateHrPrediction.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317] [--longFloorH=4]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { fitHrToEffortCalibrationAcrossRaces, predictHeartRateFromEffortFraction, type HrEffortCalibration } from "../src/model/hrCalibration.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const FITTED_TAU_MIN = parseFloat(arg("tauMin", "317"));
const FITTED_FINF = parseFloat(arg("fInf", "0.737"));
const BIN_MINUTES = parseFloat(arg("binMinutes", "30"));
const LONG_FLOOR_H = parseFloat(arg("longFloorH", "4"));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

const TARGET_RACES = ["14579457702", "18726525125"]; // Ecotrail 80, Soria Moria

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name ?? "", points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadEdges(id: string): ValhallaSurfaceEdge[] | null {
  const p = `${SURFACE_CACHE_DIR}${id}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function evaluateCalibration(
  label: string,
  calibration: HrEffortCalibration | null,
  bins: { effortFraction: number[]; hr: number[] }[],
  binMinutes: number,
) {
  if (!calibration) {
    console.log(`  ${label}: calibration returned null`);
    return;
  }
  const errors: number[] = [];
  const rows: string[] = [];
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (b.hr.length === 0 || b.effortFraction.length === 0) continue;
    const meanEffort = b.effortFraction.reduce((a, c) => a + c, 0) / b.effortFraction.length;
    const meanHr = b.hr.reduce((a, c) => a + c, 0) / b.hr.length;
    const predicted = predictHeartRateFromEffortFraction(meanEffort, calibration);
    const err = predicted - meanHr;
    errors.push(err);
    const tCenter = ((i + 0.5) * binMinutes) / 60;
    rows.push(`    t=${tCenter.toFixed(2).padStart(6)}h  actual=${meanHr.toFixed(1)}  predicted=${predicted.toFixed(1)}  err=${err >= 0 ? "+" : ""}${err.toFixed(1)}`);
  }
  const mae = errors.reduce((a, c) => a + Math.abs(c), 0) / errors.length;
  const bias = errors.reduce((a, c) => a + c, 0) / errors.length;
  console.log(
    `  ${label}: MAE=${mae.toFixed(2)}bpm  bias=${bias >= 0 ? "+" : ""}${bias.toFixed(2)}bpm  ` +
      `(calib: slope=${calibration.slope.toFixed(4)} R^2=${calibration.rSquared.toFixed(3)} races=${calibration.raceCount})`,
  );
  return { errors, rows };
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX, fInf: FITTED_FINF, tauMin: FITTED_TAU_MIN };
  const commonInputs = {
    bodyMassKg: BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  interface Rec {
    id: string;
    name: string;
    date: Date | null;
    effortTrendPoints: EffortTrendPoint[];
    durationH: number;
    trimmed: EffortTrendPoint[];
  }
  const runs: Rec[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= MAX_ACTIVITIES) break;
    const { id, name, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const edges = loadEdges(id);
    if (!edges) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const segments = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    if (!effortTrendPoints.some((p) => p.heartRateBpm !== undefined)) continue;
    const firstTimed = points.find((p) => p.time !== null);
    const trimmed = trimForPacingFit(effortTrendPoints);
    runs.push({ id, name, date: firstTimed?.time ?? null, effortTrendPoints, durationH: analysis.totalMovingTimeS / 3600, trimmed });
    used++;
  }
  console.log(`${runs.length} activities with heart rate data\n`);

  for (const targetId of TARGET_RACES) {
    const target = runs.find((r) => r.id === targetId);
    if (!target) {
      console.log(`Target ${targetId} not found or has no HR data -- skipping`);
      continue;
    }
    console.log(`=== ${target.name} (${target.durationH.toFixed(2)}h) ===`);

    const trainingAll = runs.filter((r) => r.id !== targetId);
    const trainingLong = trainingAll.filter((r) => r.durationH >= LONG_FLOOR_H);
    console.log(`  Full-pool training set: ${trainingAll.length} races. Long-only (>=${LONG_FLOOR_H}h): ${trainingLong.length} races.`);

    const calibFull = fitHrToEffortCalibrationAcrossRaces(
      trainingAll.map((r) => r.effortTrendPoints),
      baseCeilingParams,
      { raceDates: trainingAll.map((r) => r.date) },
    );
    const calibLong = fitHrToEffortCalibrationAcrossRaces(
      trainingLong.map((r) => r.effortTrendPoints),
      baseCeilingParams,
      { raceDates: trainingLong.map((r) => r.date) },
    );

    const totalHours = target.trimmed[target.trimmed.length - 1].tHours;
    const binCount = Math.ceil((totalHours * 60) / BIN_MINUTES);
    const bins: { effortFraction: number[]; hr: number[] }[] = Array.from({ length: binCount }, () => ({ effortFraction: [], hr: [] }));
    for (const p of target.trimmed) {
      const binIdx = Math.min(binCount - 1, Math.floor((p.tHours * 60) / BIN_MINUTES));
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, baseCeilingParams);
      if (ceiling > 0) bins[binIdx].effortFraction.push(p.grossPowerWPerKg / ceiling);
      if (p.heartRateBpm !== undefined) bins[binIdx].hr.push(p.heartRateBpm);
    }

    evaluateCalibration("full-pool (production today)", calibFull, bins, BIN_MINUTES);
    evaluateCalibration(`long-only (>=${LONG_FLOOR_H}h)`, calibLong, bins, BIN_MINUTES);
    console.log();
  }
}

main();
