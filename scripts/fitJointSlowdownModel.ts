// PLAN.md §14 Plan B, Stage 5: real-data run of jointSlowdownFit.ts across
// the cached run library. Reuses Stage 0/3's .surface-cache/ (surface
// category is one of the jointly-fit terms) -- offline, no new Valhalla
// calls.
//
// Runs all 3 aerobic-clock x 4 impact-basis combinations (one term from
// each category at a time, per the user's own scoping) and prints every
// combination's coefficients, within-run R^2, and VIFs side by side --
// deliberately NOT picking a winner here (see jointSlowdownFit.ts's own
// module doc for why in-sample fit can't arbitrate between a linear-in-
// accumulator fade and the existing exponential tau curve).
//
// Usage:
//   npx tsx scripts/fitJointSlowdownModel.ts [--bodyMassKg=70] [--maxActivities=250]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type LibraryRunInput } from "../src/model/segmentLibrary.ts";
import {
  fitJointSlowdownModel,
  type AerobicClockBasis,
  type ImpactBasis,
} from "../src/model/jointSlowdownFit.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

const AEROBIC_BASES: AerobicClockBasis[] = ["elapsedHours", "netWork", "hardWork"];
const IMPACT_BASES: ImpactBasis[] = ["descentMeters", "descentImpact", "descentImpactSquared", "runningImpact"];

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
  // ceilingParams: {} (opt-in default) enables cumulativeHardWorkJPerKgAtStart
  // with default athlete constants -- see monotonicSegments.ts's own doc for
  // why that's a real caveat on the hardWork basis specifically, not the others.
  const library = buildSegmentLibrary(runs, { bodyMassKg: BODY_MASS_KG, ceilingParams: {} });
  console.log(`Segment library: ${library.length} monotonic segments across ${runs.length} runs\n`);

  console.log(
    "Each row: one aerobic-fade-clock term + one impact term, jointly fit with surface category, within-run\n" +
      "fixed effects (see jointSlowdownFit.ts's own doc). Coefficients are log-GAP change per unit; VIF is the\n" +
      "collinearity flag for that term (rule of thumb: >~10 means it can't be cleanly separated from the rest\n" +
      "of this same model).\n",
  );

  for (const aerobicClockBasis of AEROBIC_BASES) {
    for (const impactBasis of IMPACT_BASES) {
      const result = fitJointSlowdownModel(library, { aerobicClockBasis, impactBasis });
      const label = `${aerobicClockBasis} + ${impactBasis}`;
      if (!result) {
        console.log(`${label.padEnd(38)} -- no usable fit (too few within-run-variant segments, or singular design)`);
        continue;
      }
      console.log(`${label} (runs=${result.runCount}, segments=${result.segmentCount}, within-run R^2=${result.rSquaredWithinRun.toFixed(3)})`);
      for (let i = 0; i < result.columns.length; i++) {
        const vif = result.variableInflationFactors[i];
        console.log(
          `  ${result.columns[i].padEnd(14)} coef=${result.coefficients[i].toExponential(3).padStart(11)}  VIF=${vif === Infinity ? "inf" : vif.toFixed(2)}`,
        );
      }
    }
  }

  console.log(
    "\nRead: no combination above is crowned a winner from this table alone. A high within-run R^2 or a\n" +
      "large-magnitude coefficient can come from overfitting a small number of runs just as easily as from a\n" +
      "real effect (jointSlowdownFit.ts's own doc). A high VIF on the aerobic-clock or impact term means this\n" +
      "particular combination can't separate the two fatigue channels -- read its coefficients with that in\n" +
      "mind, don't just take the larger one at face value. The held-out finish-time backtest is still the\n" +
      "arbiter for whether any of these combinations earns a place in ceiling.ts.",
  );
}

main();
