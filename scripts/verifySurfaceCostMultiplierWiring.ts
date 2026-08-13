// Sanity check that pacingFit.ts's fitSurfaceCostMultipliersFromIntensity
// (now wired into RunLibraryPanel.runFit(), replacing the flat
// fitUnpavedCostMultiplierAcrossRaces flow) reproduces the same numbers
// fitIntensityConditionedSlowdownModel's own script already showed the
// user, end to end through the production wrapper rather than the raw
// regression -- confirms the coefficient->multiplier conversion and column
// filtering are wired correctly, not just unit-tested on synthetic data.
//
// Usage: npx tsx scripts/verifySurfaceCostMultiplierWiring.ts

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary } from "../src/model/segmentLibrary.ts";
import { fitSurfaceCostMultipliersFromIntensity } from "../src/model/pacingFit.ts";

const BODY_MASS_KG = 85;
const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const libraryInputs: { runId: string; segments: ReturnType<typeof runPipeline>["segments"] }[] = [];

  for (const file of files) {
    const id = file.match(/activity-([^/]+)\.json$/)?.[1] ?? file;
    const raw = JSON.parse(readFileSync(`${CACHE_DIR}${file}`, "utf8")) as CachedActivityPoints;
    const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (!points.some((p) => p.time !== null)) continue;
    const surfacePath = `${SURFACE_CACHE_DIR}${id}.json`;
    let edges: ValhallaSurfaceEdge[] | null = null;
    try {
      edges = JSON.parse(readFileSync(surfacePath, "utf8"));
    } catch {
      continue;
    }
    if (!edges) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    libraryInputs.push({ runId: id, segments: attachSurfaceData(course.segments, edges) });
  }

  console.log(`Runs with surface data: ${libraryInputs.length}`);
  const library = buildSegmentLibrary(libraryInputs, { bodyMassKg: BODY_MASS_KG, ceilingParams: {} });
  const result = fitSurfaceCostMultipliersFromIntensity(library);
  if (!result) {
    console.log("Fit returned null.");
    return;
  }
  console.log(`runCount=${result.runCount} segmentCount=${result.segmentCount} rSquaredWithinRun=${result.rSquaredWithinRun.toFixed(4)}\n`);
  for (const [category, multiplier] of Object.entries(result.surfaceCostMultipliers)) {
    const vif = result.variableInflationFactors[category as keyof typeof result.variableInflationFactors];
    console.log(`${category.padEnd(10)} ${multiplier!.toFixed(3)}x  (${((multiplier! - 1) * 100).toFixed(1)}% slower)  VIF=${vif?.toFixed(2)}`);
  }
}

main();
