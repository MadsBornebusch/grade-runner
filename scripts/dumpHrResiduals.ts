// PLAN.md §14 Plan B, HR-prediction follow-up: dumps per-bin (actual HR,
// predicted HR, error) triples for Ecotrail 80 and Soria Moria, using the
// ACTUAL shipped fitHrToEffortCalibrationAcrossRaces (duration gate +
// start trim baked in), leave-one-out. Written as JSON for a residual-vs-
// actual-HR plot -- checks whether the error has a systematic pattern
// against the actual value (e.g. worse at high or low HR) rather than
// just reporting one averaged MAE number.
//
// Usage: npx tsx scripts/dumpHrResiduals.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { fitHrToEffortCalibrationAcrossRaces, predictHeartRateFromEffortFraction } from "../src/model/hrCalibration.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const FINF = parseFloat(arg("fInf", "0.737"));
const TAU_MIN = parseFloat(arg("tauMin", "317"));
const BIN_MINUTES = 30;
const OUT_PATH = arg("outPath", fileURLToPath(new URL("../.hr-residuals.json", import.meta.url)));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const TARGET_RACES = [
  { id: "14579457702", label: "Ecotrail 80" },
  { id: "18726525125", label: "Soria Moria" },
];

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadEdges(id: string): ValhallaSurfaceEdge[] | null {
  const p = `${SURFACE_CACHE_DIR}${id}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX, fInf: FINF, tauMin: TAU_MIN };
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
    date: Date | null;
    effortTrendPoints: EffortTrendPoint[];
    trimmed: EffortTrendPoint[];
  }
  const runs: Rec[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= MAX_ACTIVITIES) break;
    const { id, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
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
    runs.push({ id, date: firstTimed?.time ?? null, effortTrendPoints, trimmed });
    used++;
  }

  const out: { race: string; actualHr: number; predictedHr: number; error: number; tHours: number }[] = [];

  for (const { id, label } of TARGET_RACES) {
    const target = runs.find((r) => r.id === id);
    if (!target) continue;
    const training = runs.filter((r) => r.id !== id);
    const calibration = fitHrToEffortCalibrationAcrossRaces(
      training.map((r) => r.effortTrendPoints),
      baseCeilingParams,
      { raceDates: training.map((r) => r.date) },
    );
    if (!calibration) continue;

    const totalHours = target.trimmed[target.trimmed.length - 1].tHours;
    const binCount = Math.ceil((totalHours * 60) / BIN_MINUTES);
    const bins: { effortFraction: number[]; hr: number[] }[] = Array.from({ length: binCount }, () => ({ effortFraction: [], hr: [] }));
    for (const p of target.trimmed) {
      const binIdx = Math.min(binCount - 1, Math.floor((p.tHours * 60) / BIN_MINUTES));
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, baseCeilingParams);
      if (ceiling > 0) bins[binIdx].effortFraction.push(p.grossPowerWPerKg / ceiling);
      if (p.heartRateBpm !== undefined) bins[binIdx].hr.push(p.heartRateBpm);
    }

    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (b.hr.length === 0 || b.effortFraction.length === 0) continue;
      const meanEffort = b.effortFraction.reduce((a, c) => a + c, 0) / b.effortFraction.length;
      const meanHr = b.hr.reduce((a, c) => a + c, 0) / b.hr.length;
      const predicted = predictHeartRateFromEffortFraction(meanEffort, calibration);
      out.push({ race: label, actualHr: meanHr, predictedHr: predicted, error: predicted - meanHr, tHours: ((i + 0.5) * BIN_MINUTES) / 60 });
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} bin residuals to ${OUT_PATH}`);
}

main();
