// PLAN.md §14 Plan B, Stage 7 follow-up: two questions the side-by-side
// intensity comparison didn't directly answer.
//
// 1. How much of the within-run pace variance does surface explain, on top
//    of grade/intensity/clock/impact? fitIntensityConditionedSlowdownModel's
//    own R^2 is for the WHOLE model (dominated by grade -- pace varies far
//    more with grade than with surface). This isolates surface's own
//    contribution by fitting the identical model with every segment's
//    surfaceCategory forced to a single constant value first (so no
//    non-reference dummy survives, i.e. the same model minus surface) and
//    comparing R^2 to the real fit -- an incremental-R^2 read, not a
//    from-scratch mechanism.
//
// 2. What's the actual observed pace spread within each surface category?
//    Context for the fitted coefficients' magnitude: raw pace mixes grade
//    variation in with surface (a category's own segments span many
//    grades), so this is NOT a surface-isolated number the way the fitted
//    coefficients are -- it's descriptive, to show how big the ~1-10%
//    fitted slowdowns are next to the much larger grade-driven spread
//    within each category.
//
// Usage:
//   npx tsx scripts/surfaceExplainedVariance.ts [--bodyMassKg=70] [--maxActivities=250]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint, type SurfaceCategory } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import type { TaggedMonotonicSegment } from "../src/model/segmentLibrary.ts";
import { fitIntensityConditionedSlowdownModel } from "../src/model/intensityConditionedSlowdownFit.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);

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

function paceMinPerKm(speedMs: number): number {
  return 1000 / speedMs / 60;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
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
  const runningLibrary = library.filter((s) => s.gaitMode === "run" && s.surfaceCategory !== undefined && s.avgHeartRateBpm !== null);

  console.log(`Running/known-surface/known-HR segments: ${runningLibrary.length} across ${runs.length} runs\n`);

  // --- Question 1: incremental R^2 from surface, pulse arm ---
  const withSurface = fitIntensityConditionedSlowdownModel(runningLibrary, {
    intensityBasis: "pulse",
    aerobicClockBasis: "elapsedHours",
    impactBasis: "descentMeters",
  });
  const forcedSingleCategory: TaggedMonotonicSegment[] = runningLibrary.map((s) => ({ ...s, surfaceCategory: "paved" as SurfaceCategory }));
  const withoutSurface = fitIntensityConditionedSlowdownModel(forcedSingleCategory, {
    intensityBasis: "pulse",
    aerobicClockBasis: "elapsedHours",
    impactBasis: "descentMeters",
  });

  console.log("=== How much of the within-run pace variance does surface explain? (pulse arm) ===");
  if (withSurface && withoutSurface) {
    console.log(`  Full model (intensity+grade+surface+clock+impact): within-run R^2 = ${withSurface.rSquaredWithinRun.toFixed(4)}`);
    console.log(`  Same model with surface forced constant (no surface term): within-run R^2 = ${withoutSurface.rSquaredWithinRun.toFixed(4)}`);
    console.log(`  Incremental R^2 from adding surface: ${(withSurface.rSquaredWithinRun - withoutSurface.rSquaredWithinRun).toFixed(4)}`);
    console.log(
      "  Read: this isolates surface's own contribution on top of grade/intensity/clock/impact -- grade\n" +
        "  dominates the base model (steep vs flat swamps surface-category differences in raw variance\n" +
        "  terms), so a modest incremental R^2 here is expected even when the fitted surface coefficients\n" +
        "  themselves (Stage 7's own table) are real and stable.\n",
    );
  } else {
    console.log("  -- one of the two fits failed (see above)\n");
  }

  // --- Question 2: observed pace spread per surface category ---
  console.log("=== Observed pace spread per surface category (raw, NOT grade-adjusted -- descriptive only) ===");
  const byCategory = new Map<SurfaceCategory, number[]>();
  for (const s of runningLibrary) {
    const cat = s.surfaceCategory as SurfaceCategory;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(paceMinPerKm(s.avgSpeedMs));
  }
  for (const [cat, paces] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sorted = [...paces].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(sorted.reduce((sum, p) => sum + (p - mean) ** 2, 0) / n);
    const p25 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const p75 = quantile(sorted, 0.75);
    console.log(
      `  ${cat.padEnd(10)} n=${String(n).padEnd(5)} mean=${mean.toFixed(2)} min/km  std=${std.toFixed(2)}  median=${median.toFixed(2)}  IQR=[${p25.toFixed(2)}, ${p75.toFixed(2)}]`,
    );
  }
  console.log(
    "\n  Read: this spread is dominated by grade (a category's own segments span flat to steep), not by\n" +
      "  surface -- it's NOT apples-to-apples with the fitted surface coefficients above, which already\n" +
      "  control for grade. It's here as context for how big a ~1-10% fitted slowdown is against the much\n" +
      "  larger natural pace variability within any one category.",
  );
}

main();
