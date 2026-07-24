// PLAN.md §14 Plan B, pacing-margin follow-up: held-out finish-time
// backtest comparing findSustainableTheta (the existing model -- a
// constant theta multiplier on top of a ceiling that decays continuously
// with elapsed time WITHIN the simulated race) against
// findFlatPacedFinishTime (perfect/even pacing -- a single flat effort
// fraction set by the SAME fitted tau/f0/fInf curve, but read off the
// race's own total duration instead of its own running elapsed time).
//
// Deliberately isolates ONE mechanism at a time: no surface multiplier,
// no per-category cost term -- baseline-only aerobic+fuel simulation for
// BOTH candidates, so any error delta is attributable to the pacing model
// change alone, not entangled with Stage 5-7's separate surface question
// (see backtestSurfaceMultiplier.ts for that axis).
//
// Reports overall error AND stratified by two things a second-opinion
// review flagged as the actual discriminating signal (not just the
// aggregate mean):
// - Duration bucket (ground-truth actual finish time): the theory
//   predicts the flat-pacing correction should be near-zero for short
//   efforts (well under tau) and peak in the multi-tau ultra range -- if
//   flat pacing helps roughly UNIFORMLY across every duration instead,
//   that would suggest it's behaving like a constant margin, not a
//   genuinely duration-shaped mechanism.
// - Whether the OLD model was aerobically-limited (theta≈1, fuel never
//   bound) vs fuel-limited (theta<1) for that same fold -- a fuel-limited
//   fold's old prediction can already sit below the flat curve, so flat
//   pacing might move those the OPPOSITE direction (faster, not slower).
//
// Usage:
//   npx tsx scripts/backtestFlatPacing.ts [--bodyMassKg=70] [--vo2Max=50] [--maxActivities=250] [--maxFolds=20] [--raceOnly=true]

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, fitTauFInfWithSupportGate, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { findFlatPacedFinishTime, findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import { buildWithinRaceDiagnosticPoint } from "../src/model/withinRaceDescentDiagnostic.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const VO2_MAX = parseFloat(arg("vo2Max", "50"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const MAX_FOLDS = parseInt(arg("maxFolds", "20"), 10);
const RACE_ONLY = arg("raceOnly", "false") === "true";
// "evenlySpaced" (default) samples by FILE-LISTING index, which ends up
// roughly chronological, not duration-ordered -- since ordinary short
// training runs vastly outnumber long ones in this athlete's cache, that
// draws almost entirely from the short end. "longest" instead sorts by
// actual recorded duration and takes the top MAX_FOLDS -- the only way to
// actually get multi-hour folds into the target set, which is what's
// needed to test whether the flat-pacing correction is genuinely
// duration-shaped (PLAN.md's own prediction: near-zero short, peaking
// around 2-4x tau) rather than just a small roughly-constant nudge.
const TARGET_SELECTION = arg("targetSelection", "evenlySpaced") as "evenlySpaced" | "longest";
// Synchronous append, one JSON line per completed fold -- survives a hard
// kill mid-run (this machine has intermittently killed this script
// partway through a full k-fold pass), unlike the final summary table,
// which only ever gets printed once every fold has completed.
const OUTCOMES_JSONL_PATH = arg("outcomesPath", fileURLToPath(new URL("../.backtest-flatpacing-outcomes.jsonl", import.meta.url)));

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

interface RunRecord {
  id: string;
  date: Date | null;
  segments: CourseSegment[];
  effortTrendPoints: EffortTrendPoint[];
  actualFinishTimeS: number;
  isSustainedEffort: boolean;
}

interface FoldOutcome {
  actualFinishTimeS: number;
  thetaErrorPct: number;
  flatErrorPct: number;
  oldWasAerobicallyLimited: boolean;
}

function durationBucket(actualFinishTimeS: number): string {
  const hours = actualFinishTimeS / 3600;
  if (hours < 1) return "<1h";
  if (hours < 2) return "1-2h";
  if (hours < 4) return "2-4h";
  if (hours < 8) return "4-8h";
  if (hours < 15) return "8-15h";
  return "15h+";
}

function summarize(label: string, errors: number[]): void {
  if (errors.length === 0) {
    console.log(`  ${label.padEnd(30)} n=0`);
    return;
  }
  const n = errors.length;
  const meanSigned = errors.reduce((a, b) => a + b, 0) / n;
  const meanAbs = errors.reduce((a, b) => a + Math.abs(b), 0) / n;
  const sorted = [...errors].sort((a, b) => a - b);
  const medianSigned = sorted[Math.floor(n / 2)];
  console.log(
    `  ${label.padEnd(30)} n=${String(n).padStart(3)}  mean signed=${meanSigned >= 0 ? "+" : ""}${meanSigned.toFixed(2)}%  mean|err|=${meanAbs.toFixed(2)}%  median signed=${medianSigned >= 0 ? "+" : ""}${medianSigned.toFixed(2)}%`,
  );
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX };
  const commonInputs = {
    bodyMassKg: BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  const runs: RunRecord[] = [];
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
    if (!course.hasTimestamps || course.totalDistance3D <= 0) {
      skipped++;
      continue;
    }
    const segments = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    const isSustainedEffort =
      buildWithinRaceDiagnosticPoint(id, { ...course, segments }, { ...commonInputs, ceilingParams: baseCeilingParams }) !== null;
    const firstTimed = points.find((p) => p.time !== null);
    runs.push({ id, date: firstTimed?.time ?? null, isSustainedEffort, segments, effortTrendPoints, actualFinishTimeS: analysis.totalMovingTimeS });
  }

  console.log(`Activities used: ${runs.length} (skipped ${skipped} without timestamps, cached surface data, or distance)\n`);

  let targetIndices: number[];
  if (RACE_ONLY) {
    targetIndices = runs.map((_, i) => i).filter((i) => runs[i].isSustainedEffort);
    console.log(`--raceOnly: ${targetIndices.length} of ${runs.length} activities clear the sustained-effort gate\n`);
  } else if (TARGET_SELECTION === "longest") {
    const foldCount = Math.min(MAX_FOLDS, runs.length);
    targetIndices = runs
      .map((_, i) => i)
      .sort((a, b) => runs[b].actualFinishTimeS - runs[a].actualFinishTimeS)
      .slice(0, foldCount);
    console.log(
      `--targetSelection=longest: durations ${(runs[targetIndices[targetIndices.length - 1]].actualFinishTimeS / 3600).toFixed(2)}h - ${(runs[targetIndices[0]].actualFinishTimeS / 3600).toFixed(2)}h\n`,
    );
  } else {
    const foldCount = Math.min(MAX_FOLDS, runs.length);
    targetIndices = Array.from({ length: foldCount }, (_, i) => Math.floor((i * runs.length) / foldCount));
  }

  writeFileSync(OUTCOMES_JSONL_PATH, "");
  const outcomes: FoldOutcome[] = [];
  let foldsRun = 0;

  for (const targetIdx of targetIndices) {
    const target = runs[targetIdx];
    if (target.actualFinishTimeS <= 0) continue;
    const foldStart = Date.now();
    process.stderr.write(`fold ${foldsRun + 1}/${targetIndices.length} (${target.id})... `);

    const trainingRuns = runs.filter((_, i) => i !== targetIdx);
    const races = trainingRuns.map((r) => r.effortTrendPoints);
    const raceDates = trainingRuns.map((r) => r.date);
    const safeFit = fitTauFInfWithSupportGate(races, baseCeilingParams, { raceDates });
    const fittedCeilingParams = safeFit.ceilingParams;

    const solverInputs: SolverInputs = { segments: target.segments, ...commonInputs, ceilingParams: fittedCeilingParams };
    const thetaBased = findSustainableTheta(solverInputs);
    const flatBased = findFlatPacedFinishTime(solverInputs);

    if (thetaBased.result.feasible && flatBased.result.feasible) {
      const thetaErrorPct = (100 * (thetaBased.result.finishTimeS - target.actualFinishTimeS)) / target.actualFinishTimeS;
      const flatErrorPct = (100 * (flatBased.result.finishTimeS - target.actualFinishTimeS)) / target.actualFinishTimeS;
      // Printed per-fold (not just in the final summary) so a crash midway
      // through a long k-fold run -- fitTauFInfWithSupportGate's own cost
      // scales with pool size, and this machine has intermittently killed
      // the process partway through -- doesn't throw away every completed
      // fold's result along with it.
      console.log(
        `  fold result: actual=${(target.actualFinishTimeS / 3600).toFixed(2)}h theta=${thetaErrorPct >= 0 ? "+" : ""}${thetaErrorPct.toFixed(2)}% flat=${flatErrorPct >= 0 ? "+" : ""}${flatErrorPct.toFixed(2)}%`,
      );
      const outcome: FoldOutcome = {
        actualFinishTimeS: target.actualFinishTimeS,
        thetaErrorPct,
        flatErrorPct,
        oldWasAerobicallyLimited: thetaBased.theta >= 0.999,
      };
      outcomes.push(outcome);
      appendFileSync(OUTCOMES_JSONL_PATH, JSON.stringify({ runId: target.id, ...outcome }) + "\n");
    }
    foldsRun++;
    process.stderr.write(`total=${Date.now() - foldStart}ms\n`);
  }

  console.log(`Held-out folds run: ${foldsRun}, both models feasible: ${outcomes.length}\n`);

  console.log("=== Overall ===");
  summarize("theta-based (existing model)", outcomes.map((o) => o.thetaErrorPct));
  summarize("flat-paced (perfect/even pacing)", outcomes.map((o) => o.flatErrorPct));

  console.log("\n=== By duration bucket (ground-truth actual finish time) ===");
  const buckets = ["<1h", "1-2h", "2-4h", "4-8h", "8-15h", "15h+"];
  for (const bucket of buckets) {
    const inBucket = outcomes.filter((o) => durationBucket(o.actualFinishTimeS) === bucket);
    if (inBucket.length === 0) continue;
    console.log(`${bucket}:`);
    summarize("theta-based", inBucket.map((o) => o.thetaErrorPct));
    summarize("flat-paced", inBucket.map((o) => o.flatErrorPct));
  }

  console.log("\n=== By whether the OLD model was aerobically-limited (theta>=0.999) vs fuel-limited ===");
  for (const [label, filterFn] of [
    ["aerobically-limited (theta==1)", (o: FoldOutcome) => o.oldWasAerobicallyLimited],
    ["fuel-limited (theta<1)", (o: FoldOutcome) => !o.oldWasAerobicallyLimited],
  ] as const) {
    const subset = outcomes.filter(filterFn);
    console.log(`${label}:`);
    summarize("theta-based", subset.map((o) => o.thetaErrorPct));
    summarize("flat-paced", subset.map((o) => o.flatErrorPct));
  }

  console.log(
    "\nRead: negative signed error means under-prediction (predicted faster than actual), same convention as\n" +
      "backtestSurfaceMultiplier.ts. The theory predicts flat-pacing's correction should be small for short\n" +
      "buckets and largest in the multi-hour ultra buckets -- if it instead moves every bucket by roughly the\n" +
      "same amount, that looks more like a constant margin than a genuinely duration-shaped mechanism. The\n" +
      "aerobic-vs-fuel-limited split checks whether fuel-limited folds move the OPPOSITE direction, as flagged\n" +
      "as a real possibility before this was built.",
  );
}

main();
