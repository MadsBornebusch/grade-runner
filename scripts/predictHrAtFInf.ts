// PLAN.md §14 Plan B, tau/fInf-fix follow-up: converts the newly-fitted
// fInf (~0.7-0.74, a fraction of VO2max) into a predicted heart rate for
// this athlete, using the existing hrCalibration.ts machinery
// (fitHrToEffortCalibrationAcrossRaces + predictHeartRateFromEffortFraction)
// -- a concrete, checkable number instead of an abstract fraction.
//
// Usage: npx tsx scripts/predictHrAtFInf.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.7,0.737]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { fitHrToEffortCalibrationAcrossRaces, predictHeartRateFromEffortFraction } from "../src/model/hrCalibration.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const FINF_VALUES = arg("fInf", "0.38,0.7,0.737").split(",").map(Number);

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

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
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX };
  const commonInputs = {
    bodyMassKg: BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
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
    races.push(effortTrendPoints);
    raceDates.push(firstTimed?.time ?? null);
    used++;
  }
  console.log(`${races.length} activities with heart rate data used for the HR<->effort calibration\n`);

  for (const fInf of FINF_VALUES) {
    const ceilingParams: CeilingParams = { ...baseCeilingParams, fInf };
    const calibration = fitHrToEffortCalibrationAcrossRaces(races, ceilingParams, { raceDates });
    if (!calibration) {
      console.log(`fInf=${fInf}: calibration returned null`);
      continue;
    }
    const predictedHr = predictHeartRateFromEffortFraction(fInf, calibration);
    console.log(
      `fInf=${fInf.toFixed(3)} -> predicted HR=${predictedHr.toFixed(1)} bpm  ` +
        `(calibration: slope=${calibration.slope.toFixed(4)} intercept=${calibration.intercept.toFixed(3)} ` +
        `R^2=${calibration.rSquared.toFixed(3)} points=${calibration.pointCount} races=${calibration.raceCount})`,
    );
  }
}

main();
