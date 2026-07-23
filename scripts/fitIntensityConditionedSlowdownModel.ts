// PLAN.md §14 Plan B, Stage 7: real-data run of
// intensityConditionedSlowdownFit.ts across the cached run library --
// three parallel fits (pulse, Minetti-modelled power, measured device
// power) of the SAME log(speed) ~ intensity + grade + surface + clock +
// impact model, compared side by side.
//
// Fair-comparison mechanics: the three arms need measured device power,
// heart rate, and Minetti power respectively, and comparing raw R^2 across
// arms fit on different populations would conflate "different intensity
// basis" with "different population". This restricts all three to the
// INTERSECTION (segments with both HR and device power, on top of the
// usual gait/surface filters) for the head-to-head, then separately
// reports pulse on its own native sample -- intended to be a BROADER,
// HR-only population, since that's the one actually useful for a course
// with no device-power history. In practice, on THIS cache, that row comes
// out identical to the intersection row: .surface-cache/ was itself
// pre-filtered back in Stage 0 to hasPower && hasTime activities only, so
// every segment here already has both instruments. The broader-population
// check this was meant to provide is untestable with the current cache,
// not something this run confirmed is unnecessary.
//
// One aerobicClockBasis/impactBasis combination only (elapsedHours +
// descentMeters) -- Stage 5's own script already covers the full 3x4 grid
// for that axis; this script's whole point is the intensity axis, and
// crossing both would just triple the noise in the table without adding
// anything this comparison is about.
//
// Usage:
//   npx tsx scripts/fitIntensityConditionedSlowdownModel.ts [--bodyMassKg=70] [--maxActivities=250]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import type { TaggedMonotonicSegment } from "../src/model/segmentLibrary.ts";
import { fitIntensityConditionedSlowdownModel, type IntensityBasis } from "../src/model/intensityConditionedSlowdownFit.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

const INTENSITY_BASES: IntensityBasis[] = ["pulse", "modelledPower", "measuredPower"];

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

function printResult(label: string, result: ReturnType<typeof fitIntensityConditionedSlowdownModel>) {
  if (!result) {
    console.log(`${label.padEnd(18)} -- no usable fit (too few within-run-variant segments, or singular design)`);
    return;
  }
  console.log(`${label} (runs=${result.runCount}, segments=${result.segmentCount}, within-run R^2=${result.rSquaredWithinRun.toFixed(4)})`);
  for (let i = 0; i < result.columns.length; i++) {
    const vif = result.variableInflationFactors[i];
    console.log(
      `  ${result.columns[i].padEnd(14)} coef=${result.coefficients[i].toExponential(3).padStart(11)}  VIF=${vif === Infinity ? "inf" : vif.toFixed(2)}`,
    );
  }
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const runs: LibraryRunInput[] = [];
  let skipped = 0;

  for (const file of files) {
    if (runs.length >= MAX_ACTIVITIES) break;
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
    runs.push({ runId: id, segments: attachSurfaceData(course.segments, edges) });
  }

  console.log(`Activities used: ${runs.length} (skipped ${skipped} without timestamps or cached surface data)`);
  const library = buildSegmentLibrary(runs, { bodyMassKg: BODY_MASS_KG });
  console.log(`Segment library: ${library.length} monotonic segments across ${runs.length} runs\n`);

  const runningLibrary = library.filter((s) => s.gaitMode === "run" && s.surfaceCategory !== undefined);
  const withHr = runningLibrary.filter((s) => s.avgHeartRateBpm !== null);
  const withPower = runningLibrary.filter((s) => s.avgMeasuredPowerWPerKg !== null);
  const intersection: TaggedMonotonicSegment[] = runningLibrary.filter(
    (s) => s.avgHeartRateBpm !== null && s.avgMeasuredPowerWPerKg !== null,
  );
  console.log(
    `Running+known-surface segments: ${runningLibrary.length} total, ${withHr.length} with HR, ${withPower.length} with device power, ${intersection.length} with both (the fair head-to-head population).\n`,
  );

  console.log("=== Head-to-head: all three arms restricted to the SAME segments (HR and device power both present) ===");
  for (const intensityBasis of INTENSITY_BASES) {
    const result = fitIntensityConditionedSlowdownModel(intersection, {
      intensityBasis,
      aerobicClockBasis: "elapsedHours",
      impactBasis: "descentMeters",
    });
    printResult(intensityBasis, result);
  }

  console.log(
    "\nRead: modelledPower's R^2 is NOT reliably near 1 at real monotonic-segment granularity -- a real run\n" +
      "found 0.44 with intensity's own VIF at 1.15 (not blown out), well short of the point-level circularity\n" +
      "signature intensityConditionedSlowdownFit.test.ts locks in synthetically. That's because\n" +
      "avgMinettiGrossPowerWPerKg averages PER-POINT power across a run that's only constant in grade SIGN,\n" +
      "not grade value -- a different, nonlinearly-averaged view of the same data than avgGradient/avgSpeedMs\n" +
      "(see PLAN.md §14 stage 7 and this module's own doc). A higher R^2 here still isn't fit-quality evidence\n" +
      "for modelledPower -- read it as residual point-level speed-power coupling, diluted not eliminated by\n" +
      "averaging. What DOES still hold: both power-based arms under-read the surface slowdown relative to\n" +
      "pulse on every category (Stage 3's original 'power absorbs some of the true slowdown' finding, now\n" +
      "partial rather than complete). Pulse's own surface/clock/impact coefficients are the ones to trust here\n" +
      "-- it's the only intensity reading that isn't itself derived from pace -- though see PLAN.md's own\n" +
      "caveat on HR lag before leaning on the exact magnitude.\n",
  );

  console.log("=== Pulse on its own native sample (no device-power availability restriction) ===");
  printResult("pulse (native)", fitIntensityConditionedSlowdownModel(withHr, { intensityBasis: "pulse", aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" }));

  console.log(
    "\nIntended as the broader, HR-only population an athlete with no footpod would actually have -- but on\n" +
      "THIS cache it comes out identical to the intersection-population pulse row above, because\n" +
      ".surface-cache/ was itself pre-filtered back in Stage 0 to hasPower && hasTime activities, so every\n" +
      "cached segment already carries both instruments. This row can't currently test what it was built to\n" +
      "test; that would need a cache built without the hasPower prefilter.",
  );
}

main();
