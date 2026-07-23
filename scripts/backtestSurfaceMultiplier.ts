// PLAN.md §14 Plan B, Stage 6: the held-out finish-time backtest, the
// arbiter every other mechanism in this file answers to. Runs entirely
// OFFLINE from the two caches Stages 0/3 already built (.strava-cache/,
// .surface-cache/) -- no live server or Strava session needed, unlike
// backtestFinishTime.ts's single-target manual design, since every
// activity's GPS points and surface edges are already local.
//
// K-fold (not full leave-one-out -- see MAX_FOLDS's own doc for why) across
// evenly-spaced target activities with usable timestamps and cached
// surface data: for each target race, fit tau/fInf AND Stage 5's joint
// surface model on every OTHER activity, then predict the target's finish
// time through the real solver (findSustainableTheta) two ways -- baseline
// (no surface term) vs. baseline + Stage 5's fitted per-category
// surfaceCostMultipliers -- and compare both to the target's actual
// recorded moving time.
//
// Scoped to the PRIMARY comparison only (baseline vs. baseline + Stage 5's
// surface term) -- deliberately NOT running all twelve Stage 5 clock/impact
// combinations through this backtest and picking the best held-out
// performer, which would overfit the arbiter itself, the exact failure
// this step exists to prevent. A secondary fatigue-channel candidate
// (hardWork+descentImpactSquared, the one pair with VIF~1.0-2.0 throughout
// Stage 5) was considered but dropped: it would need a genuinely NEW
// continuously-accumulating cost-side mechanism in solver.ts (nothing like
// it exists today -- only ceiling.ts's descent-based
// durabilityDriftPerDescentUnit, a ceiling-side term with different
// plumbing), and Stage 5 already found that combination's own coefficient
// negligible (~1e-6). Building real plumbing for a term already showing no
// signal isn't justified yet; left as a flagged follow-up, not faked here.
//
// Per-run EffortTrendPoints and monotonic-segment-library entries are
// precomputed ONCE up front (not per fold) -- a fold's training set is
// just "everything except the target run's own precomputed rows",
// filtered from the shared pool, so this stays O(N) pipeline runs instead
// of O(N^2).
//
// Usage:
//   npx tsx scripts/backtestSurfaceMultiplier.ts [--bodyMassKg=70] [--maxActivities=250] [--maxFolds=20]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildSegmentLibrary, type TaggedMonotonicSegment } from "../src/model/segmentLibrary.ts";
import { fitJointSlowdownModel } from "../src/model/jointSlowdownFit.ts";
import { buildEffortTrendPoints, fitTauFInfWithSupportGate, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
// fitTauFInfWithSupportGate's grid search cost scales with the training
// pool size -- confirmed empirically: ~75-80s per fold once the training
// pool reaches ~200 races (vs. ~12s at ~24 races), all of it in that one
// call (fitJointSlowdownModel's own fit takes ~20-50ms regardless of pool
// size). Full leave-one-out across ~200+ activities would take hours.
// k-fold with evenly-SPACED targets (not a random sample -- deterministic,
// since Math.random() isn't needed and reruns should be reproducible) keeps
// each fold's training pool at (almost) full size while bounding total
// runtime to roughly MAX_FOLDS x one full-size fit (~25 min at the default 20).
const MAX_FOLDS = parseInt(arg("maxFolds", "20"), 10);

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
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = resolveCeilingParams(formInputs);
  const commonInputs = {
    bodyMassKg: formInputs.bodyMassKg,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(formInputs),
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
    // Raw (no surface multiplier applied) -- matches backtestFinishTime.ts's
    // own convention for building tau/fInf training data.
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    const firstTimed = points.find((p) => p.time !== null);
    runs.push({
      id,
      date: firstTimed?.time ?? null,
      segments,
      effortTrendPoints,
      actualFinishTimeS: analysis.totalMovingTimeS,
    });
  }

  console.log(`Activities used: ${runs.length} (skipped ${skipped} without timestamps, cached surface data, or distance)\n`);

  const library: TaggedMonotonicSegment[] = buildSegmentLibrary(
    runs.map((r) => ({ runId: r.id, segments: r.segments })),
    { bodyMassKg: BODY_MASS_KG, ceilingParams: {} },
  );

  interface CandidateAgg {
    name: string;
    applySurface: boolean;
    absPctErrors: number[];
    signedPctErrors: number[];
    foldsSkipped: number;
  }
  const candidates: CandidateAgg[] = [
    { name: "baseline (no surface term)", applySurface: false, absPctErrors: [], signedPctErrors: [], foldsSkipped: 0 },
    { name: "baseline + fitted per-category surface", applySurface: true, absPctErrors: [], signedPctErrors: [], foldsSkipped: 0 },
  ];

  // Evenly-spaced target indices across the whole pool (deterministic, not
  // a random sample) rather than every index -- see MAX_FOLDS's own doc.
  const foldCount = Math.min(MAX_FOLDS, runs.length);
  const targetIndices = Array.from({ length: foldCount }, (_, i) => Math.floor((i * runs.length) / foldCount));

  let foldsRun = 0;
  for (const targetIdx of targetIndices) {
    const target = runs[targetIdx];
    if (target.actualFinishTimeS <= 0) continue;
    const foldStart = Date.now();
    process.stderr.write(`fold ${foldsRun + 1}/${targetIndices.length} (${target.id})... `);

    const trainingRuns = runs.filter((_, i) => i !== targetIdx);
    const races = trainingRuns.map((r) => r.effortTrendPoints);
    const raceDates = trainingRuns.map((r) => r.date);
    const t0 = Date.now();
    const safeFit = fitTauFInfWithSupportGate(races, baseCeilingParams, { raceDates });
    const fittedCeilingParams = safeFit.ceilingParams;
    const t1 = Date.now();

    const trainingLibrary = library.filter((s) => s.runId !== target.id);

    const surfaceFit = fitJointSlowdownModel(trainingLibrary, { aerobicClockBasis: "elapsedHours", impactBasis: "descentMeters" });
    const t2 = Date.now();
    process.stderr.write(`tauFit=${t1 - t0}ms surfaceFit=${t2 - t1}ms `);
    // Converts jointSlowdownFit.ts's log-GAP surface coefficients into
    // solver.ts-style cost multipliers: log(speed) shifts by `coefficient`
    // relative to paved at fixed grade/clock/impact (see
    // jointSlowdownFit.ts's own doc), and solver.ts's terrainMultiplier
    // divides speed for a fixed target power, so multiplier = exp(-coefficient).
    const surfaceCostMultipliers: Record<string, number> = {};
    if (surfaceFit) {
      for (let i = 0; i < surfaceFit.columns.length; i++) {
        const col = surfaceFit.columns[i];
        if (col === "grade" || col === "gradeSquared" || col === "aerobicClock" || col === "impact") continue;
        surfaceCostMultipliers[col] = Math.exp(-surfaceFit.coefficients[i]);
      }
    }

    foldsRun++;
    for (const candidate of candidates) {
      const solverInputs: SolverInputs = {
        segments: target.segments,
        ...commonInputs,
        ceilingParams: fittedCeilingParams,
        ...(candidate.applySurface ? { surfaceCostMultipliers } : {}),
      };
      const { result } = findSustainableTheta(solverInputs);
      if (!result.feasible) {
        candidate.foldsSkipped++;
        continue;
      }
      const errorS = result.finishTimeS - target.actualFinishTimeS;
      const errorPct = (100 * errorS) / target.actualFinishTimeS;
      candidate.absPctErrors.push(Math.abs(errorPct));
      candidate.signedPctErrors.push(errorPct);
    }
    process.stderr.write(`total=${Date.now() - foldStart}ms\n`);
  }

  console.log(`Held-out folds run: ${foldsRun}\n`);
  console.log("candidate                                              n    mean|err%|  median|err%|  mean signed err%");
  for (const c of candidates) {
    const n = c.absPctErrors.length;
    if (n === 0) {
      console.log(`${c.name.padEnd(52)} 0 (no feasible folds)`);
      continue;
    }
    const meanAbs = c.absPctErrors.reduce((a, b) => a + b, 0) / n;
    const sorted = [...c.absPctErrors].sort((a, b) => a - b);
    const medianAbs = sorted[Math.floor(n / 2)];
    const meanSigned = c.signedPctErrors.reduce((a, b) => a + b, 0) / n;
    console.log(
      `${c.name.padEnd(52)} ${String(n).padStart(3)}  ${meanAbs.toFixed(2).padStart(9)}%  ${medianAbs.toFixed(2).padStart(10)}%  ${meanSigned >= 0 ? "+" : ""}${meanSigned.toFixed(2)}%` +
        (c.foldsSkipped > 0 ? `  (${c.foldsSkipped} folds infeasible)` : ""),
    );
  }
}

main();
