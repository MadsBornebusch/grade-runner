// PLAN.md §14 Plan B, pacing-margin follow-up: the flat-pacing backtest's
// per-fold joint tau/fInf fit landed at tau=22min/fInf=0.777 for most folds
// -- nothing like the tau=250min/fInf=0.38 calibration defaults used
// everywhere else in this plan. This script reproduces one fold's training
// pool exactly (Soria Moria held out, same as the backtest) and inspects
// the fit's own internals: race duration distribution, which races count
// as "informative" (unresponsive=false) vs not, and what happens to the
// fitted tau/fInf if the pool is restricted to informative races only --
// the pooled objective sums EVERY race's squared slope with no
// down-weighting by informativeness (informativeRaceCount is a reporting/
// gating signal, not a fit-time weight), so if short races numerically
// dominate the pool, they could be pulling the minimizer away from what
// the genuinely long/informative races alone would prefer.
//
// Usage: npx tsx scripts/diagnoseTauFInfFit.ts [--bodyMassKg=85] [--vo2Max=54] [--excludeId=18726525125]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, fitFInfAndTauAcrossRaces, fitTauFInfWithSupportGate, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { buildWithinRaceDiagnosticPoint } from "../src/model/withinRaceDescentDiagnostic.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const EXCLUDE_ID = arg("excludeId", "18726525125"); // Soria Moria, same fold as the backtest

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name ?? "", points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadCachedSurfaceEdges(activityId: string): ValhallaSurfaceEdge[] | null {
  const cachePath = `${SURFACE_CACHE_DIR}${activityId}.json`;
  if (!existsSync(cachePath)) return null;
  return JSON.parse(readFileSync(cachePath, "utf8")) as ValhallaSurfaceEdge[];
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

  interface Rec {
    id: string;
    name: string;
    date: Date | null;
    effortTrendPoints: EffortTrendPoint[];
    durationH: number;
    isSustainedEffort: boolean;
  }
  const runs: Rec[] = [];

  for (const file of files) {
    if (runs.length >= MAX_ACTIVITIES) break;
    const { id, name, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const edges = loadCachedSurfaceEdges(id);
    if (!edges) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const segments = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    const isSustainedEffort =
      buildWithinRaceDiagnosticPoint(id, { ...course, segments }, { ...commonInputs, ceilingParams: baseCeilingParams }) !== null;
    const firstTimed = points.find((p) => p.time !== null);
    runs.push({ id, name, date: firstTimed?.time ?? null, effortTrendPoints, durationH: analysis.totalMovingTimeS / 3600, isSustainedEffort });
  }

  console.log(`Loaded ${runs.length} activities\n`);

  const training = runs.filter((r) => r.id !== EXCLUDE_ID);
  console.log(`Training pool (excluding ${EXCLUDE_ID}): ${training.length} races\n`);

  // Duration distribution
  const durations = training.map((r) => r.durationH).sort((a, b) => a - b);
  const buckets = [0.25, 0.5, 1, 2, 4, 8, 15, Infinity];
  let lo = 0;
  for (const hi of buckets) {
    const count = durations.filter((d) => d >= lo && d < hi).length;
    console.log(`  ${lo}h-${hi === Infinity ? "inf" : hi + "h"}: ${count}`);
    lo = hi;
  }
  console.log(
    `\nShortest: ${durations[0].toFixed(2)}h, Longest: ${durations[durations.length - 1].toFixed(2)}h, Median: ${durations[Math.floor(durations.length / 2)].toFixed(2)}h\n`,
  );

  const races = training.map((r) => r.effortTrendPoints);
  const raceDates = training.map((r) => r.date);

  const fullFit = fitFInfAndTauAcrossRaces(races, baseCeilingParams, { raceDates });
  if (!fullFit) {
    console.log("Full-pool joint fit returned null");
    return;
  }
  console.log(
    `Full pool joint fit: tau=${fullFit.tauMin}min fInf=${fullFit.fInf} durationDiversityRatio=${fullFit.durationDiversityRatio.toFixed(2)} informative=${fullFit.informativeRaceCount}/${fullFit.perRace.length} hitBoundary=fInf:${fullFit.hitSearchBoundary.fInf} tau:${fullFit.hitSearchBoundary.tau}\n`,
  );

  const safeFit = fitTauFInfWithSupportGate(races, baseCeilingParams, { raceDates });
  console.log(`Support-gated result: tier=${safeFit.tier} tau=${safeFit.ceilingParams.tauMin} fInf=${safeFit.ceilingParams.fInf}\n`);

  // List informative races (unresponsive === false) with their own durations
  const informative = training.filter((_, i) => !fullFit.perRace[i].unresponsive);
  const uninformative = training.filter((_, i) => fullFit.perRace[i].unresponsive);
  console.log(`Informative races (${informative.length}):`);
  for (const r of informative.slice(0, 30)) {
    console.log(`  ${r.name.padEnd(30)} ${r.durationH.toFixed(2)}h`);
  }
  console.log(`\nUninformative/unresponsive races: ${uninformative.length} (durations ${Math.min(...uninformative.map((r) => r.durationH)).toFixed(2)}h - ${Math.max(...uninformative.map((r) => r.durationH)).toFixed(2)}h)\n`);

  // Refit using ONLY the informative races
  if (informative.length >= 2) {
    const infoRaces = informative.map((r) => r.effortTrendPoints);
    const infoDates = informative.map((r) => r.date);
    const infoFit = fitFInfAndTauAcrossRaces(infoRaces, baseCeilingParams, { raceDates: infoDates });
    if (infoFit) {
      console.log(
        `Refit using ONLY the ${informative.length} informative races: tau=${infoFit.tauMin}min fInf=${infoFit.fInf} durationDiversityRatio=${infoFit.durationDiversityRatio.toFixed(2)} informative=${infoFit.informativeRaceCount}/${infoFit.perRace.length} hitBoundary=fInf:${infoFit.hitSearchBoundary.fInf} tau:${infoFit.hitSearchBoundary.tau}`,
      );
    } else {
      console.log("Refit on informative-only pool returned null");
    }
  }

  // Refit using ONLY races that pass the existing sustained-effort gate
  // (buildWithinRaceDiagnosticPoint -- requires >=1h of "late window" past
  // the midpoint, plus a valid solo tau fit not hitting its own search
  // boundary) -- this is the gate backtestFlatPacing.ts already computes
  // per run but never actually uses to filter what goes into the tau/fInf
  // fit itself.
  const sustained = training.filter((r) => r.isSustainedEffort);
  console.log(`\nSustained-effort races (existing gate, unused by the current fit): ${sustained.length}/${training.length}`);
  for (const r of sustained) {
    console.log(`  ${r.name.padEnd(30)} ${r.durationH.toFixed(2)}h`);
  }
  if (sustained.length >= 2) {
    const sRaces = sustained.map((r) => r.effortTrendPoints);
    const sDates = sustained.map((r) => r.date);
    const sFit = fitFInfAndTauAcrossRaces(sRaces, baseCeilingParams, { raceDates: sDates });
    if (sFit) {
      console.log(
        `\nRefit using ONLY sustained-effort races: tau=${sFit.tauMin}min fInf=${sFit.fInf} durationDiversityRatio=${sFit.durationDiversityRatio.toFixed(2)} informative=${sFit.informativeRaceCount}/${sFit.perRace.length} hitBoundary=fInf:${sFit.hitSearchBoundary.fInf} tau:${sFit.hitSearchBoundary.tau}`,
      );
    } else {
      console.log("Refit on sustained-effort-only pool returned null");
    }
  } else {
    console.log("Fewer than 2 sustained-effort races -- can't refit");
  }

  // Sensitivity sweep: refit with an explicit minimum-duration floor on the
  // pool, at a few thresholds, to see how quickly tau moves as short runs
  // are excluded -- a real ultra-fatigue tau shouldn't be this sensitive to
  // an arbitrary duration cutoff if it's genuinely being identified from the
  // long end of the pool rather than the short end.
  console.log("\nSensitivity to a minimum-duration floor on the pool:");
  for (const floorH of [0, 1, 1.5, 2, 2.5, 3, 4]) {
    const pool = training.filter((r) => r.durationH >= floorH);
    if (pool.length < 2) {
      console.log(`  floor=${floorH}h: fewer than 2 races (${pool.length}), skipped`);
      continue;
    }
    const fit = fitFInfAndTauAcrossRaces(
      pool.map((r) => r.effortTrendPoints),
      baseCeilingParams,
      { raceDates: pool.map((r) => r.date) },
    );
    if (!fit) {
      console.log(`  floor=${floorH}h: n=${pool.length}, fit returned null`);
      continue;
    }
    console.log(
      `  floor=${floorH}h: n=${pool.length} tau=${fit.tauMin}min fInf=${fit.fInf} diversityRatio=${fit.durationDiversityRatio.toFixed(2)} informative=${fit.informativeRaceCount}/${fit.perRace.length} hitBoundary=fInf:${fit.hitSearchBoundary.fInf} tau:${fit.hitSearchBoundary.tau}`,
    );
  }
}

main();
