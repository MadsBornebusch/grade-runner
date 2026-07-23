// PLAN.md §14 Plan B, Stage 2 sanity check: run buildMonotonicSegments
// (verified against a synthetic course in monotonicSegments.test.ts) over
// real cached activities and report what the real segment-length
// distribution actually looks like -- the plan explicitly deferred the
// ~100m/~30s floor's exact fit to "once built, not a guess now"; this is
// that check, plus a general "does this behave sensibly on messy real GPS
// data" sanity pass.
//
// Offline-only: reuses whatever's already in .surface-cache/ from Stage 0
// (scripts/testMinettiPowerShape.ts) rather than making new Valhalla
// requests -- activities without a cached surface response are skipped and
// counted, not fetched fresh.
//
// Usage:
//   npx tsx scripts/buildSegmentLibrarySample.ts [--bodyMassKg=70] [--maxActivities=60]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildMonotonicSegments, type MonotonicSegment } from "../src/model/monotonicSegments.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "60"), 10);

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadCachedSurfaceEdges(activityId: string): ValhallaSurfaceEdge[] | null {
  const cachePath = `${SURFACE_CACHE_DIR}${activityId}.json`;
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, "utf8")) as ValhallaSurfaceEdge[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  console.log(`Found ${files.length} cached activities.\n`);

  const allRuns: MonotonicSegment[] = [];
  let usedActivities = 0;
  let skippedNoTime = 0;
  let skippedNoCachedSurface = 0;

  for (const file of files) {
    if (usedActivities >= MAX_ACTIVITIES) break;
    const { id, points: gpxPoints } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!gpxPoints.some((p) => p.time !== null)) {
      skippedNoTime++;
      continue;
    }
    const edges = loadCachedSurfaceEdges(id);
    if (!edges) {
      skippedNoCachedSurface++;
      continue;
    }

    const course = runPipeline(gpxPoints);
    const withSurface = attachSurfaceData(course.segments, edges);
    const runs = buildMonotonicSegments(withSurface, {
      bodyMassKg: BODY_MASS_KG,
      ceilingParams: { vo2MaxMlPerKgPerMin: 50, lt2Fraction: 0.85 },
    });
    allRuns.push(...runs);
    usedActivities++;
  }

  console.log(
    `Activities used: ${usedActivities} (skipped ${skippedNoTime} without timestamps, ${skippedNoCachedSurface} without a cached surface response)`,
  );
  console.log(`Total monotonic segments produced: ${allRuns.length}\n`);

  const distances = allRuns.map((r) => r.distance3D).sort((a, b) => a - b);
  const times = allRuns.map((r) => r.timeS).sort((a, b) => a - b);
  console.log("Distance (m):  p10=%s  p50=%s  p90=%s  max=%s", ...[0.1, 0.5, 0.9, 1].map((p) => (p === 1 ? distances[distances.length - 1] : percentile(distances, p)).toFixed(0)));
  console.log("Duration (s):  p10=%s  p50=%s  p90=%s  max=%s", ...[0.1, 0.5, 0.9, 1].map((p) => (p === 1 ? times[times.length - 1] : percentile(times, p)).toFixed(0)));

  const bySurface = new Map<string, number>();
  const byGait = new Map<string, number>();
  let withMeasuredPower = 0;
  for (const r of allRuns) {
    const s = r.surfaceCategory ?? "unknown";
    bySurface.set(s, (bySurface.get(s) ?? 0) + 1);
    byGait.set(r.gaitMode, (byGait.get(r.gaitMode) ?? 0) + 1);
    if (r.avgMeasuredPowerWPerKg !== null) withMeasuredPower++;
  }

  console.log("\nSurface category breakdown:");
  for (const [cat, count] of [...bySurface.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(10)} ${count} (${((100 * count) / allRuns.length).toFixed(1)}%)`);
  }
  console.log("\nGait breakdown:");
  for (const [gait, count] of byGait.entries()) {
    console.log(`  ${gait.padEnd(10)} ${count} (${((100 * count) / allRuns.length).toFixed(1)}%)`);
  }
  console.log(`\nSegments with any measured (device) power: ${withMeasuredPower} (${((100 * withMeasuredPower) / allRuns.length).toFixed(1)}%)`);

  const avgSegmentsPerActivity = allRuns.length / usedActivities;
  console.log(`\nAverage monotonic segments per activity: ${avgSegmentsPerActivity.toFixed(1)}`);

  // Sanity only -- allRuns is flattened across activities (no run-of-origin
  // field yet, see PLAN.md §14 stage 2's own flagged TODO), so this is just
  // "does cumulative descent exposure reach plausible, growing values
  // somewhere in the library", not a per-activity or per-athlete summary.
  const maxDescentM = Math.max(...allRuns.map((r) => r.cumulativeDescentMAtStart));
  const maxDescentImpact = Math.max(...allRuns.map((r) => r.cumulativeDescentImpactAtStart));
  console.log(`\nMax cumulativeDescentMAtStart seen anywhere in the library: ${maxDescentM.toFixed(0)} m`);
  console.log(`Max cumulativeDescentImpactAtStart seen anywhere in the library: ${maxDescentImpact.toFixed(0)} m·m/s`);
}

main();
