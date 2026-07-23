// PLAN.md §14 Plan B, Stage 3: gate check on fitSurfaceCostTable.ts's own
// method. That module holds device (Stryd) power constant and asks whether
// speed differs by surface -- which only means something if Stryd's power
// reading itself actually responds to surface roughness. If it doesn't (if
// power is essentially a function of speed+grade alone, which is exactly
// how a footpod without a way to sense trail roughness would behave), the
// whole residual/multiplier approach is structurally blind to a real
// surface effect, and a near-1.0 result would be an artifact of the
// instrument, not evidence there's no cost.
//
// Directly checks the premise instead of assuming it: bins running-gait
// segments with device power by (grade, speed) -- not by grade alone, since
// this specifically asks "at the SAME pace AND grade, does power read
// differently by surface" -- and compares mean device power per surface
// category within each matched cell.
//
// No network calls -- reuses Stage 0's .surface-cache/, offline.
//
// Usage:
//   npx tsx scripts/testStrydSurfaceSensitivity.ts [--bodyMassKg=70] [--maxActivities=220]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "220"), 10);
const GRADE_BIN = 0.05;
const SPEED_BIN = 0.5;
const MIN_CELL_N = 3;

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
  for (const file of files) {
    if (runs.length >= MAX_ACTIVITIES) break;
    const { id, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const edges = loadCachedSurfaceEdges(id);
    if (!edges) continue;
    const course = runPipeline(points);
    runs.push({ runId: id, segments: attachSurfaceData(course.segments, edges) });
  }

  const library = buildSegmentLibrary(runs, { bodyMassKg: BODY_MASS_KG });

  const cells = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const seg of library) {
    if (seg.gaitMode !== "run" || seg.surfaceCategory === undefined || seg.avgMeasuredPowerWPerKg === null) continue;
    const gradeBin = Math.round(seg.avgGradient / GRADE_BIN) * GRADE_BIN;
    const speedBin = Math.round(seg.avgSpeedMs / SPEED_BIN) * SPEED_BIN;
    const key = `${gradeBin}|${speedBin}`;
    if (!cells.has(key)) cells.set(key, new Map());
    const catMap = cells.get(key)!;
    if (!catMap.has(seg.surfaceCategory)) catMap.set(seg.surfaceCategory, { sum: 0, n: 0 });
    const e = catMap.get(seg.surfaceCategory)!;
    e.sum += seg.avgMeasuredPowerWPerKg;
    e.n += 1;
  }

  const ratiosByCategory = new Map<string, Array<{ ratio: number; weight: number }>>();
  let cellsWithPavedAndOther = 0;
  for (const catMap of cells.values()) {
    const paved = catMap.get("paved");
    if (!paved || paved.n < MIN_CELL_N) continue;
    const pavedMean = paved.sum / paved.n;
    for (const [cat, e] of catMap.entries()) {
      if (cat === "paved" || e.n < MIN_CELL_N) continue;
      cellsWithPavedAndOther++;
      if (!ratiosByCategory.has(cat)) ratiosByCategory.set(cat, []);
      ratiosByCategory.get(cat)!.push({ ratio: e.sum / e.n / pavedMean, weight: e.n });
    }
  }

  console.log(`Library: ${library.length} segments across ${runs.length} runs`);
  console.log(`(grade x speed) cells with paved + another category, both n>=${MIN_CELL_N}: ${cellsWithPavedAndOther}\n`);
  console.log("category    n cells   weighted mean device-power ratio (other/paved) at MATCHED speed+grade");
  for (const [cat, arr] of ratiosByCategory.entries()) {
    const totalWeight = arr.reduce((s, r) => s + r.weight, 0);
    const weightedMean = arr.reduce((s, r) => s + r.ratio * r.weight, 0) / totalWeight;
    console.log(`${cat.padEnd(10)}  ${String(arr.length).padStart(6)}    ${weightedMean.toFixed(4)}`);
  }
  console.log(
    "\nRead: ratios close to 1.0 across categories mean device power barely responds to surface at matched\n" +
      "pace+grade -- the instrument can't see terrain roughness (unsurprising: a footpod has no way to sense\n" +
      "trail technicality directly). That means fitSurfaceCostTable.ts's own near-1.0 multipliers are an\n" +
      "artifact of what the instrument can report, not evidence a real surface cost doesn't exist -- see\n" +
      "testHrBySurface.ts for an independent (not power/speed-derived) check of the same question.",
  );
}

main();
