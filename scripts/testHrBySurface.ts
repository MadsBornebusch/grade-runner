// PLAN.md §14 Plan B, Stage 3: the real arbiter testStrydSurfaceSensitivity.ts's
// own result points to -- device power turned out to barely respond to
// surface at matched speed+grade (a footpod has no way to sense trail
// roughness directly), so fitSurfaceCostTable.ts's near-1.0 multipliers
// can't be trusted either way. Heart rate is NOT derived from speed or
// grade the way Stryd's own power estimate substantially is, so it's a
// genuinely independent physiological signal for the same question: at
// matched pace and grade, does this athlete's body work harder on rougher
// terrain?
//
// Restricted to the early ~65% of each activity's own duration -- same
// convention as hrCalibration.ts elsewhere in this codebase -- since
// cardiac drift (HR climbing at constant true output) would otherwise
// contaminate a surface comparison the same way it would any other HR use.
//
// Reports TWO aggregations, deliberately, not just one:
// - "cross-run": pools every matched (grade,speed) cell across ALL
//   activities before comparing paved vs. another category. Confounded --
//   road-only runs contribute only paved, trail runs contribute the
//   unpaved categories, so this also compares HR on road-run DAYS against
//   HR on trail-run DAYS, and day-to-day HR baseline swings 5-10bpm from
//   heat/hydration/sleep/cumulative fatigue independent of surface. Exactly
//   the "pooled regression reflects cross-race differences, not the thing
//   being fit" lesson already written into this codebase for the tau fit
//   (PLAN.md §11), applied here to HR instead of pacing slope.
// - "within-run": only compares paved vs. another category using cells
//   from the SAME run (same day, same physiology) -- the discriminating
//   check. If the ordering survives here, the cross-run version wasn't
//   just measuring which days were hot/trail/tired. Necessarily smaller n
//   (needs a single run with both paved and the category present at a
//   matched pace+grade), and if it's too sparse to read, that itself is
//   informative about how much the cross-run number was leaning on the
//   confounded comparison.
//
// Operates on raw fixed-length CourseSegments directly (not the monotonic
// segment library), since HR isn't currently carried on MonotonicSegment
// and this diagnostic doesn't need monotonic runs -- just (speed, grade,
// surface, early-window) matched cells, now also keyed by run.
//
// No network calls -- reuses Stage 0's .surface-cache/, offline.
//
// Usage:
//   npx tsx scripts/testHrBySurface.ts [--maxActivities=220] [--earlyFraction=0.65]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { arg } from "./stravaScriptHelpers.ts";

const MAX_ACTIVITIES = parseInt(arg("maxActivities", "220"), 10);
const EARLY_FRACTION = parseFloat(arg("earlyFraction", "0.65"));
const GRADE_BIN = 0.05;
const SPEED_BIN = 0.5;
const MIN_CELL_N = 3;
const WALK_MAX_MS = 2.0;

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

interface CatStat {
  sum: number;
  n: number;
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  // runId -> "gradeBin|speedBin" -> category -> stat
  const perRunCells = new Map<string, Map<string, Map<string, CatStat>>>();
  let usedActivities = 0;

  for (const file of files) {
    if (usedActivities >= MAX_ACTIVITIES) break;
    const { id, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null) || !points.some((p) => p.hr !== null)) continue;
    const edges = loadCachedSurfaceEdges(id);
    if (!edges) continue;

    const course = runPipeline(points);
    const withSurface = attachSurfaceData(course.segments, edges);
    usedActivities++;

    const totalElapsedS = withSurface.reduce((sum, s) => sum + (s.dtS ?? 0), 0);
    const cutoffS = totalElapsedS * EARLY_FRACTION;
    let elapsedS = 0;
    for (const seg of withSurface) {
      const dt = seg.dtS;
      const stillEarly = elapsedS <= cutoffS;
      if (dt !== null && dt > 0) elapsedS += dt;
      if (seg.paused || dt === null || dt <= 0 || seg.heartRateBpm === null || seg.surfaceCategory === undefined || !stillEarly) {
        continue;
      }
      const speedMs = seg.distance3D / dt;
      if (speedMs <= WALK_MAX_MS) continue; // running gait only, matching the power-sensitivity check

      const gradeBin = Math.round(seg.gradient / GRADE_BIN) * GRADE_BIN;
      const speedBin = Math.round(speedMs / SPEED_BIN) * SPEED_BIN;
      const cellKey = `${gradeBin}|${speedBin}`;

      if (!perRunCells.has(id)) perRunCells.set(id, new Map());
      const runCells = perRunCells.get(id)!;
      if (!runCells.has(cellKey)) runCells.set(cellKey, new Map());
      const catMap = runCells.get(cellKey)!;
      if (!catMap.has(seg.surfaceCategory)) catMap.set(seg.surfaceCategory, { sum: 0, n: 0 });
      const e = catMap.get(seg.surfaceCategory)!;
      e.sum += seg.heartRateBpm;
      e.n += 1;
    }
  }

  // Cross-run: pool every run's contribution into one global cell per (grade,speed) first.
  const pooledCells = new Map<string, Map<string, CatStat>>();
  for (const runCells of perRunCells.values()) {
    for (const [cellKey, catMap] of runCells.entries()) {
      if (!pooledCells.has(cellKey)) pooledCells.set(cellKey, new Map());
      const pooledCatMap = pooledCells.get(cellKey)!;
      for (const [cat, e] of catMap.entries()) {
        if (!pooledCatMap.has(cat)) pooledCatMap.set(cat, { sum: 0, n: 0 });
        const pooled = pooledCatMap.get(cat)!;
        pooled.sum += e.sum;
        pooled.n += e.n;
      }
    }
  }

  function diffsFromCells(cellsByCat: Iterable<Map<string, CatStat>>): Map<string, Array<{ diffBpm: number; weight: number }>> {
    const diffs = new Map<string, Array<{ diffBpm: number; weight: number }>>();
    for (const catMap of cellsByCat) {
      const paved = catMap.get("paved");
      if (!paved || paved.n < MIN_CELL_N) continue;
      const pavedMean = paved.sum / paved.n;
      for (const [cat, e] of catMap.entries()) {
        if (cat === "paved" || e.n < MIN_CELL_N) continue;
        if (!diffs.has(cat)) diffs.set(cat, []);
        diffs.get(cat)!.push({ diffBpm: e.sum / e.n - pavedMean, weight: e.n });
      }
    }
    return diffs;
  }

  function printDiffs(label: string, diffs: Map<string, Array<{ diffBpm: number; weight: number }>>): void {
    console.log(`\n${label}`);
    console.log("category    n comparisons   weighted mean HR diff vs paved (bpm)");
    if (diffs.size === 0) {
      console.log("  (no comparable cells)");
      return;
    }
    for (const [cat, arr] of diffs.entries()) {
      const totalWeight = arr.reduce((s, r) => s + r.weight, 0);
      const weightedMean = arr.reduce((s, r) => s + r.diffBpm * r.weight, 0) / totalWeight;
      console.log(`${cat.padEnd(10)}  ${String(arr.length).padStart(13)}    ${weightedMean >= 0 ? "+" : ""}${weightedMean.toFixed(2)} bpm`);
    }
  }

  console.log(`Activities with HR+time+cached surface used: ${usedActivities}`);

  const crossRunDiffs = diffsFromCells(pooledCells.values());
  printDiffs("CROSS-RUN (confounded -- pools road-run days against trail-run days, see module doc):", crossRunDiffs);

  const withinRunCellMaps: Array<Map<string, CatStat>> = [];
  for (const runCells of perRunCells.values()) for (const catMap of runCells.values()) withinRunCellMaps.push(catMap);
  const withinRunDiffs = diffsFromCells(withinRunCellMaps);
  printDiffs("WITHIN-RUN (the discriminating check -- same day, same physiology, matched pace+grade):", withinRunDiffs);

  console.log(
    "\nRead: if the within-run ordering/magnitude survives close to the cross-run numbers, the surface\n" +
      "effect isn't just road-day-vs-trail-day HR baseline drift. If it collapses (or there's too little\n" +
      "within-run data to say), the cross-run numbers can't be trusted as a surface effect -- defer to the\n" +
      "held-out finish-time backtest (Stage 5) rather than resurrecting a surface term from this alone.\n" +
      "Either way, converting bpm into an effort-fraction/cost-multiplier still needs hrCalibration.ts's own\n" +
      "fit, documented there as R²=0.24 (weak) for this athlete -- read bpm as an ordered signal, not yet a\n" +
      "precise multiplier.",
  );
}

main();
