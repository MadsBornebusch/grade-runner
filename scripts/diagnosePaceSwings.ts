// Diagnoses a user report: predicted pace on the Planning page oscillates
// wildly (~3 to 20+ min/km) on what looks like a steady downhill, km 17-21
// of Oslo Trail Challenge 55km. Reproduces the exact solver output for that
// stretch against the real cached course data, dumping grade/mode/speed/
// surface per segment to see what's actually driving it.
//
// Usage: npx tsx scripts/diagnosePaceSwings.ts

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";

const OSLO_2024_ID = "12524841443";
const REAL_VO2_MAX = 54;
const REAL_BODY_MASS_KG = 85;
// This session's real applied values, per the user's own "Currently applied" report.
const REAL_TAU_MIN = 321;
const REAL_F_INF = 0.69;
const SURFACE_COST_MULTIPLIERS = { gravel: 1.03, dirt: 1.03, compacted: 1.05, path: 1.12 };

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function main() {
  const raw = JSON.parse(readFileSync(`${CACHE_DIR}activity-${OSLO_2024_ID}.json`, "utf8")) as CachedActivityPoints;
  const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(points);

  let segments = course.segments;
  const surfacePath = `${SURFACE_CACHE_DIR}${OSLO_2024_ID}.json`;
  if (existsSync(surfacePath)) {
    const edges = JSON.parse(readFileSync(surfacePath, "utf8")) as ValhallaSurfaceEdge[];
    segments = attachSurfaceData(segments, edges);
  }

  const formInputs = DEFAULT_FORM_INPUTS;
  const ceilingParams = {
    ...resolveCeilingParams(formInputs),
    vo2MaxMlPerKgPerMin: REAL_VO2_MAX,
    tauMin: REAL_TAU_MIN,
    fInf: REAL_F_INF,
  };
  const solverInputs: SolverInputs = {
    segments,
    bodyMassKg: REAL_BODY_MASS_KG,
    ceilingParams,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: REAL_BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    altitudeAdjustment: formInputs.altitudeAdjustment,
    surfaceCostMultipliers: SURFACE_COST_MULTIPLIERS,
  };

  const { theta, result } = findSustainableTheta(solverInputs);
  console.log(`theta=${theta.toFixed(3)} feasible=${result.feasible} finishTimeS=${result.finishTimeS.toFixed(0)}\n`);

  console.log("km".padStart(7), "grade%".padStart(8), "mode".padStart(6), "pace(min/km)".padStart(13), "surface".padStart(10), "gain/kg".padStart(9));
  for (let i = 0; i < segments.length; i++) {
    const km = segments[i].cumulativeDistance3D / 1000;
    if (km < 17 || km > 21) continue;
    const seg = segments[i];
    const r = result.segments[i];
    const paceMinPerKm = r.speedMs > 0 ? 1000 / r.speedMs / 60 : Infinity;
    console.log(
      km.toFixed(3).padStart(7),
      (seg.gradient * 100).toFixed(1).padStart(8),
      r.mode.padStart(6),
      paceMinPerKm.toFixed(2).padStart(13),
      (seg.surfaceCategory ?? "?").padStart(10),
      r.grossPowerWPerKg.toFixed(2).padStart(9),
    );
  }
}

main();
