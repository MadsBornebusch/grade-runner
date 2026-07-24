// PLAN.md §14 Plan B, HR-prediction-quality follow-up: hrCalibration.ts's
// own header doc cites a real-data check of R^2=0.31 raw -> ~0.43 smoothed
// -- but that check ran on 3 curated real ultras, not this athlete's full
// 203-activity library (mostly ordinary training runs). Re-running the
// same fit against the full library gives R^2=0.10-ish (see
// scripts/predictHrAtFInf.ts's own real-data numbers) -- a large gap.
// Exactly the same shape as the tau/fInf swamping bug this session already
// found and fixed: hundreds of short, noisy training runs pooled unweighted
// alongside a handful of genuine long efforts. This sweeps a minimum-
// duration floor on the pool to see whether R^2 recovers toward the
// documented 0.31-0.43+ range as short runs are excluded.
//
// Usage: npx tsx scripts/diagnoseHrCalibration.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317]

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
const FINF = parseFloat(arg("fInf", "0.737"));
const TAU_MIN = parseFloat(arg("tauMin", "317"));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

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
    name: string;
    date: Date | null;
    effortTrendPoints: EffortTrendPoint[];
    durationH: number;
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
    runs.push({ id, name, date: firstTimed?.time ?? null, effortTrendPoints, durationH: analysis.totalMovingTimeS / 3600 });
    used++;
  }
  console.log(`${runs.length} activities with heart rate data\n`);

  console.log("Sensitivity to a minimum-duration floor on the pool:");
  for (const floorH of [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8]) {
    const pool = runs.filter((r) => r.durationH >= floorH);
    if (pool.length < 2) {
      console.log(`  floor=${floorH}h: fewer than 2 races (${pool.length}), skipped`);
      continue;
    }
    const calibration = fitHrToEffortCalibrationAcrossRaces(
      pool.map((r) => r.effortTrendPoints),
      baseCeilingParams,
      { raceDates: pool.map((r) => r.date) },
    );
    if (!calibration) {
      console.log(`  floor=${floorH}h: n=${pool.length}, calibration returned null`);
      continue;
    }
    const predictedHr = predictHeartRateFromEffortFraction(FINF, calibration);
    console.log(
      `  floor=${floorH}h: races=${pool.length} (${calibration.raceCount} contributing) points=${calibration.pointCount} ` +
        `R^2=${calibration.rSquared.toFixed(3)} slope=${calibration.slope.toFixed(4)} predictedHR@fInf=${predictedHr.toFixed(1)}`,
    );
  }
}

main();
