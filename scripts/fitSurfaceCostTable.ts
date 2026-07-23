// PLAN.md §14 Plan B, Stage 3: real-data run of buildSurfaceCostTable /
// summarizeAcrossGradeBins across the cached run library. Offline -- reuses
// Stage 0's .surface-cache/, no new Valhalla calls.
//
// Usage:
//   npx tsx scripts/fitSurfaceCostTable.ts [--bodyMassKg=70] [--maxActivities=220] [--runningGaitOnly=true]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import { buildSurfaceCostTable, summarizeAcrossGradeBins } from "../src/model/surfaceCostAnalysis.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "220"), 10);
const RUNNING_GAIT_ONLY = arg("runningGaitOnly", "true") !== "false";

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadCachedSurfaceEdges(activityId: string): ValhallaSurfaceEdge[] | null {
  const cachePath = `${SURFACE_CACHE_DIR}${activityId}.json`;
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, "utf8")) as ValhallaSurfaceEdge[];
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const runs: LibraryRunInput[] = [];
  let usedActivities = 0;
  let skipped = 0;

  for (const file of files) {
    if (usedActivities >= MAX_ACTIVITIES) break;
    const { id, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) {
      skipped++;
      continue;
    }
    const edges = loadCachedSurfaceEdges(id);
    if (!edges) {
      skipped++;
      continue;
    }
    const course = runPipeline(points);
    const withSurface = attachSurfaceData(course.segments, edges);
    runs.push({ runId: id, segments: withSurface });
    usedActivities++;
  }

  console.log(`Activities used: ${usedActivities} (skipped ${skipped} without timestamps or cached surface data)`);
  const library = buildSegmentLibrary(runs, { bodyMassKg: BODY_MASS_KG });
  console.log(`Segment library: ${library.length} monotonic segments across ${runs.length} runs\n`);

  const table = buildSurfaceCostTable(library, { runningGaitOnly: RUNNING_GAIT_ONLY });
  const sorted = [...table].sort((a, b) => a.gradeBinCenter - b.gradeBinCenter || a.surfaceCategory.localeCompare(b.surfaceCategory));

  console.log(`Per (grade bin x surface category) cell -- runningGaitOnly=${RUNNING_GAIT_ONLY}:`);
  console.log("grade    category    n     runs   rel.residual   implied multiplier vs paved");
  for (const c of sorted) {
    const rel = c.relativeToPavedLogSpeedResidual;
    const mult = c.impliedCostMultiplierVsPaved;
    console.log(
      `${(c.gradeBinCenter * 100).toFixed(1).padStart(6)}%  ${c.surfaceCategory.padEnd(10)}  ${String(c.segmentCount).padStart(4)}  ${String(c.runCount).padStart(4)}   ${rel !== null ? rel.toFixed(3).padStart(7) : "   n/a "}       ${mult !== null ? mult.toFixed(3) : "n/a"}`,
    );
  }

  console.log("\nSummary (pooled across comparable grade bins only):");
  console.log("category    comparable n   comparable bins   comparable runs (upper bound)   implied multiplier");
  for (const s of summarizeAcrossGradeBins(table)) {
    console.log(
      `${s.surfaceCategory.padEnd(10)}  ${String(s.comparableSegmentCount).padStart(11)}   ${String(s.comparableBinCount).padStart(14)}   ${String(s.comparableRunCount).padStart(26)}         ${s.impliedCostMultiplierVsPaved !== null ? s.impliedCostMultiplierVsPaved.toFixed(3) : "n/a"}`,
    );
  }
}

main();
