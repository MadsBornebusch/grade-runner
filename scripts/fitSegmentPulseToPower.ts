// PLAN.md §14 Plan B, Stage 7 follow-up: real-data run of
// segmentPulsePowerFit.ts -- how well does heart rate actually track
// modelled (and measured) power at monotonic-segment granularity, on this
// athlete's own cached data? Direct answer to "did we fit a pulse-to-power
// model on the segments" -- Stage 7's three intensity arms never did,
// they used pulse and power as separate, parallel predictors of pace.
//
// Usage:
//   npx tsx scripts/fitSegmentPulseToPower.ts [--bodyMassKg=70] [--maxActivities=250] [--minDurationS=180]
//
// Also runs a long-segment-only cut (timeS >= minDurationS) as a diagnostic:
// HR lag (~20-45s VO2/cardiac response) contaminates a short segment's whole
// average far more than a long one's, so if the near-zero modelled-power R^2
// found on the full library is mostly a lag artifact, restricting to long
// segments should recover a materially higher R^2. If it doesn't move, that's
// evidence the decoupling is real rather than an artifact of unsmoothed,
// unlagged power -- see PLAN.md §14 before building any smoothing/lag-
// correction machinery on the strength of the full-library number alone.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import { fitSegmentPulseToPower } from "../src/model/segmentPulsePowerFit.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const MIN_DURATION_S = parseFloat(arg("minDurationS", "180"));

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
  console.log(`Segment library: ${library.length} monotonic segments across ${runs.length} runs\n`);

  console.log(`-- Full library --`);
  for (const basis of ["modelled", "measured"] as const) {
    const result = fitSegmentPulseToPower(library, basis);
    if (!result) {
      console.log(`${basis} power -- no usable fit`);
      continue;
    }
    console.log(
      `${basis.padEnd(10)} power: runs=${result.runCount} segments=${result.segmentCount} slope=${result.slope.toFixed(3)} bpm per W/kg  within-run R^2=${result.rSquaredWithinRun.toFixed(4)}`,
    );
  }

  const longLibrary = library.filter((s) => s.timeS >= MIN_DURATION_S);
  console.log(`\n-- Long segments only (timeS >= ${MIN_DURATION_S}s): ${longLibrary.length} / ${library.length} segments survive --`);
  for (const basis of ["modelled", "measured"] as const) {
    const result = fitSegmentPulseToPower(longLibrary, basis);
    if (!result) {
      console.log(`${basis} power -- no usable fit`);
      continue;
    }
    console.log(
      `${basis.padEnd(10)} power: runs=${result.runCount} segments=${result.segmentCount} slope=${result.slope.toFixed(3)} bpm per W/kg  within-run R^2=${result.rSquaredWithinRun.toFixed(4)}`,
    );
  }

  console.log(
    "\nRead: this is a WITHIN-RUN (own-run baseline removed), monotonic-segment-granularity fit -- a\n" +
      "different design from hrCalibration.ts's own pooled, trailing-smoothed, early-window-restricted\n" +
      "whole-race fit (that module's own real-data check: R^2 0.31 raw -> ~0.43 with ~75s smoothing). Compare\n" +
      "this R^2 to that range as context, not as a like-for-like replication.\n" +
      "The long-segment cut is a diagnostic for whether the full-library number is a lag artifact or real\n" +
      "decoupling -- if it barely moves despite a real survivor count, the near-zero is probably genuine.",
  );
}

main();
