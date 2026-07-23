// PLAN.md §14 Plan B, Stage 4: real-data run of
// withinRaceDescentDiagnostic.ts across the cached run library, restricted
// to long-enough runs (mirroring suggestRuns.ts's own DURABILITY_MIN_DURATION_S
// 1-hour bar -- the "transfer from training runs to ultras" landmine, not a
// new threshold invented for this script).
//
// Reports ONE number per run (the late-window residual, and each early-
// window predictor), not one per segment -- the effective sample size for
// this comparison is the number of qualifying, successfully-diagnosed RUNS,
// not the much larger monotonic-segment count. Every predictor here is
// tested with the SAME method already validated in §12/§13 (synthetic tests
// in withinRaceDescentDiagnostic.test.ts): does each run's own late-window
// residual (after removing its own already-fitted single-tau decay)
// correlate with how much of that predictor accumulated in the run's early
// window. No candidate is crowned a winner from this table alone -- see
// this script's own printed caveats and PLAN.md §14 stage 4 for why (the
// net-work/hard-work candidates in particular share a negative-split
// confound with the residual they're tested against, unlike the
// descent/running-impact candidates).
//
// No network calls -- reuses only .strava-cache/, offline. Does NOT need
// .surface-cache/ (none of these candidates depend on surface data).
//
// Usage:
//   npx tsx scripts/fitFatigueClockDiagnostic.ts [--bodyMassKg=70] [--maxActivities=300] [--earlyFraction=0.5] [--minLateWindowHours=1]

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint, type PipelineResult } from "../src/gpx/pipeline.ts";
import { DURABILITY_MIN_DURATION_S } from "../src/model/suggestRuns.ts";
import {
  buildWithinRaceDiagnosticPoint,
  computeWithinRaceDescentDiagnostic,
  type WithinRaceDiagnosticPoint,
} from "../src/model/withinRaceDescentDiagnostic.ts";
import type { BuildRaceDiagnosticPointOptions } from "../src/model/raceDiagnosticPoint.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "300"), 10);
const EARLY_FRACTION = parseFloat(arg("earlyFraction", "0.5"));
const MIN_LATE_WINDOW_HOURS = parseFloat(arg("minLateWindowHours", "1"));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function durationS(points: GpxPoint[]): number {
  const timed = points.filter((p) => p.time !== null);
  if (timed.length < 2) return 0;
  const first = timed[0].time as Date;
  const last = timed[timed.length - 1].time as Date;
  return (last.getTime() - first.getTime()) / 1000;
}

const OPTIONS: BuildRaceDiagnosticPointOptions = {
  bodyMassKg: BODY_MASS_KG,
  ceilingParams: {},
  fueling: { intakeGPerH: 60 },
  glycogenStoreG: 500,
  walkMaxMs: 2.0,
  altitudeAdjustment: true,
};

interface Row {
  label: string;
  correlation: number | null;
}

function printRow(label: string, correlation: number | null): void {
  console.log(`${label.padEnd(28)}  ${correlation !== null ? correlation.toFixed(3).padStart(7) : "   n/a"}`);
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));

  let scanned = 0;
  let longEnough = 0;
  const points: WithinRaceDiagnosticPoint[] = [];

  for (const file of files) {
    if (scanned >= MAX_ACTIVITIES) break;
    const { id, points: gpxPoints } = loadCachedActivity(`${CACHE_DIR}${file}`);
    scanned++;
    if (!gpxPoints.some((p) => p.time !== null)) continue;
    if (durationS(gpxPoints) < DURABILITY_MIN_DURATION_S) continue;
    longEnough++;

    const course: PipelineResult = runPipeline(gpxPoints);
    const point = buildWithinRaceDiagnosticPoint(id, course, OPTIONS, EARLY_FRACTION, MIN_LATE_WINDOW_HOURS);
    if (point) points.push(point);
  }

  console.log(`Activities scanned: ${scanned}`);
  console.log(`Long enough (>= ${DURABILITY_MIN_DURATION_S / 3600}h, mirrors suggestRuns.ts's DURABILITY_MIN_DURATION_S): ${longEnough}`);
  console.log(`Successfully diagnosed (whole-race tau fit + late-window floors all cleared): ${points.length}`);
  console.log(
    "\nThis last number -- not the segment count anywhere else in Plan B -- is the effective sample size for\n" +
      "every correlation below: one point per RUN, not per monotonic segment. A fatigue/impact clock is a\n" +
      "per-run trajectory, so slicing a run into many segments sharpens each run's own measurement without\n" +
      "creating additional independent observations.\n",
  );

  if (points.length < 3) {
    console.log("Too few diagnosed runs to report correlations meaningfully.");
    return;
  }

  const result = computeWithinRaceDescentDiagnostic(points);
  const rows: Row[] = [
    { label: "early descent (m/km)", correlation: result.lateResidualVsEarlyDescentCorrelation },
    { label: "early descent impact (speed-wtd)", correlation: result.lateResidualVsEarlyDescentImpactCorrelation },
    { label: "early descent impact (speed^2-wtd)", correlation: result.lateResidualVsEarlyDescentImpactSquaredCorrelation },
    { label: "early running-impact score", correlation: result.lateResidualVsEarlyRunningImpactCorrelation },
    { label: "early cumulative net work", correlation: result.lateResidualVsEarlyNetWorkCorrelation },
    { label: "early cumulative hard work", correlation: result.lateResidualVsEarlyHardWorkCorrelation },
  ];

  console.log("Pearson r: late-window residual (%/hour) vs. each early-window predictor (per km of early window)");
  console.log("predictor                     r");
  for (const row of rows) printRow(row.label, row.correlation);

  console.log(
    "\nRead: the hypothesis for the four impact/descent-style predictors (rows 1-4) predicts a NEGATIVE r --\n" +
      "more early exposure going with a more negative late residual (faster-than-modeled decay afterwards).\n" +
      "Rows 5-6 (net/hard work) carry a negative-split confound the others don't: both are Minetti-derived\n" +
      "from the same GPS speed the residual's own numerator comes from, so a run paced hard early and slower\n" +
      "late will show high early work AND a negative late residual for ordinary pacing reasons, not\n" +
      "necessarily a real cumulative-fatigue effect. None of these six numbers should be used to pick a\n" +
      "winning candidate in isolation -- that's what Stage 5's held-out finish-time backtest is for.",
  );
}

main();
