// User complaint: fitUnpavedCostMultiplierAcrossRaces produces ~1.8x on
// real data, which they say is physiologically implausible (their own
// recorded power isn't elevated on unpaved terrain -- see this fit's own
// doc comment, which already documents that) AND overpredicts a real race:
// Oslo Trail Challenge 55km (2024-09-28, activity 12524841443, actual
// moving time 25561s = 7:06:01) they say the model would put at ~8h.
//
// PLAN.md SS14 Plan B Stage 6 already found a large (~22-28%), terrain-
// independent UNDER-prediction bias in the baseline solver (multiplier=1)
// across this athlete's library at their real physiology (VO2max=54,
// bodyMassKg=85) -- the opposite direction of the user's complaint. This
// script reconciles the two: reproduces the SAME production fit path
// RunLibraryPanel.runFit() uses (fitTauFInfWithSupportGate then
// fitUnpavedCostMultiplierAcrossRaces, same commonInputs shape) against
// the full offline-cached library at the athlete's real physiology, then
// triangulates Oslo 2024 specifically at multiplier in {1.0, fitted, and
// solved-for-25561s} to see where this one race actually sits relative to
// the pooled fit.
//
// Usage: npx tsx scripts/investigateTerrainMultiplierBias.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import {
  buildEffortTrendPoints,
  fitTauFInfWithSupportGate,
  fitUnpavedCostMultiplierAcrossRaces,
  type EffortTrendPoint,
  type FinishTimeTrainingRace,
} from "../src/model/pacingFit.ts";
import { findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { DURABILITY_MIN_DURATION_S } from "../src/model/suggestRuns.ts";
import { buildWithinRaceDiagnosticPoint } from "../src/model/withinRaceDescentDiagnostic.ts";

const REAL_VO2_MAX = 54;
const REAL_BODY_MASS_KG = 85;
const OSLO_2024_ID = "12524841443";
const OSLO_2024_ACTUAL_S = 25561;

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/trace_attributes";
const MAX_SHAPE_POINTS = 800;

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function downsample(points: GpxPoint[], maxPoints: number): { lat: number; lon: number }[] {
  const step = points.length <= maxPoints ? 1 : points.length / maxPoints;
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i * step < points.length; i++) out.push(points[Math.floor(i * step)]);
  return out.map((p) => ({ lat: p.lat, lon: p.lon }));
}

async function fetchSurfaceEdgesCached(activityId: string, points: GpxPoint[]): Promise<ValhallaSurfaceEdge[] | null> {
  if (!existsSync(SURFACE_CACHE_DIR)) mkdirSync(SURFACE_CACHE_DIR, { recursive: true });
  const cachePath = `${SURFACE_CACHE_DIR}${activityId}.json`;
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as ValhallaSurfaceEdge[];
  if (points.length < 2) return null;
  const shape = downsample(points, MAX_SHAPE_POINTS);
  try {
    const res = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shape,
        costing: "pedestrian",
        shape_match: "map_snap",
        filters: { attributes: ["edge.surface", "edge.length"], action: "include" },
      }),
    });
    if (!res.ok) {
      console.log(`  surface lookup failed (${res.status}) for ${activityId}`);
      return null;
    }
    const body = (await res.json()) as { edges?: ValhallaSurfaceEdge[] };
    const edges = body.edges ?? [];
    writeFileSync(cachePath, JSON.stringify(edges));
    return edges;
  } catch (err) {
    console.log(`  surface lookup errored for ${activityId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main() {
  const formInputs = DEFAULT_FORM_INPUTS;
  const ceilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: REAL_VO2_MAX };
  const commonInputs = {
    bodyMassKg: REAL_BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: REAL_BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  console.log(`Scanning ${files.length} cached activities (fetching surface data for Oslo 2024 if missing)...\n`);

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
  const finishTimeRaces: (FinishTimeTrainingRace & { id: string; name: string; isSustainedEffort: boolean })[] = [];
  let sawOslo2024 = false;

  for (const file of files) {
    const { id, name, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const isOslo2024 = id === OSLO_2024_ID;
    if (isOslo2024) sawOslo2024 = true;
    const edges = await fetchSurfaceEdgesCached(id, points);
    if (!edges) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const segments: CourseSegment[] = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { bodyMassKg: REAL_BODY_MASS_KG, ceilingParams, ...commonInputs });
    if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) continue;
    const isSustainedEffort =
      buildWithinRaceDiagnosticPoint(id, { ...course, segments }, { bodyMassKg: REAL_BODY_MASS_KG, ceilingParams, ...commonInputs }) !== null;
    races.push(buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment));
    raceDates.push(points.find((p) => p.time !== null)?.time ?? null);
    finishTimeRaces.push({ id, name, segments, actualFinishTimeS: analysis.totalMovingTimeS, isSustainedEffort });
  }
  console.log(`Of these, ${finishTimeRaces.filter((r) => r.isSustainedEffort).length} clear the sustained-effort (race-like) gate.\n`);

  console.log(`Training pool: ${finishTimeRaces.length} runs >= ${DURABILITY_MIN_DURATION_S / 3600}h with surface data.`);
  if (!sawOslo2024) console.log("WARNING: Oslo 2024 (12524841443) not found in .strava-cache -- results below won't include it.\n");

  const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates });
  console.log(`\ntau/fInf fit tier: ${safeFit.tier}, ceilingParams: tauMin=${safeFit.ceilingParams.tauMin?.toFixed(1)} fInf=${safeFit.ceilingParams.fInf?.toFixed(3)} f0=${safeFit.ceilingParams.f0?.toFixed(3)}\n`);

  const multiplierFit = fitUnpavedCostMultiplierAcrossRaces(finishTimeRaces, safeFit.ceilingParams, commonInputs, { raceDates });
  if (!multiplierFit) {
    console.log("Multiplier fit returned null (no informative races).");
    return;
  }
  console.log(
    `Fitted unpavedCostMultiplier = ${multiplierFit.unpavedCostMultiplier.toFixed(3)}x (informative=${multiplierFit.informativeRaceCount}, hitBoundary=${multiplierFit.hitSearchBoundary ?? "no"})\n`,
  );

  console.log("Per-race baseline (1x) vs fitted-multiplier % error, sorted by |baseline error| descending:");
  console.log("name".padEnd(45), "baselineErr%".padStart(13), "fitErr%".padStart(10), "unresponsive");
  const withNames = finishTimeRaces.map((r, i) => ({ ...r, result: multiplierFit.perRace[i] }));
  withNames.sort((a, b) => Math.abs(b.result.baselineErrPct) - Math.abs(a.result.baselineErrPct));
  for (const r of withNames.slice(0, 25)) {
    console.log(
      r.name.slice(0, 44).padEnd(45),
      r.result.baselineErrPct.toFixed(1).padStart(12) + "%",
      r.result.fitErrPct.toFixed(1).padStart(9) + "%",
      r.result.unresponsive ? "  (no unpaved)" : "",
    );
  }
  const signedBaseline = multiplierFit.perRace.map((r) => r.baselineErrPct);
  const meanSignedBaseline = signedBaseline.reduce((a, b) => a + b, 0) / signedBaseline.length;
  console.log(`\nMean SIGNED baseline error across all ${signedBaseline.length} races (positive = overpredicts finish time): ${meanSignedBaseline >= 0 ? "+" : ""}${meanSignedBaseline.toFixed(2)}%`);

  const oslo = withNames.find((r) => r.id === OSLO_2024_ID);
  if (!oslo) {
    console.log("\nOslo 2024 not in training pool (skipped -- check surface fetch above).");
    return;
  }
  console.log(`\n=== Oslo Trail Challenge 55km 2024 (actual ${OSLO_2024_ACTUAL_S}s = 7:06:01) ===`);
  console.log(`baseline (1x) error: ${oslo.result.baselineErrPct.toFixed(2)}%  |  fitted (${multiplierFit.unpavedCostMultiplier.toFixed(2)}x) error: ${oslo.result.fitErrPct.toFixed(2)}%`);

  const predictAt = (m: number): number => {
    const solverInputs: SolverInputs = { segments: oslo.segments, ceilingParams: safeFit.ceilingParams, unpavedCostMultiplier: m, ...commonInputs };
    const { result } = findSustainableTheta(solverInputs, { scanSteps: 12, iterations: 18 });
    return result.finishTimeS;
  };

  const fmt = (s: number) => `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60).toString().padStart(2, "0")}m`;
  const at1 = predictAt(1.0);
  const atFit = predictAt(multiplierFit.unpavedCostMultiplier);
  console.log(`predicted @ 1.0x:    ${fmt(at1)} (${at1}s)`);
  console.log(`predicted @ ${multiplierFit.unpavedCostMultiplier.toFixed(2)}x: ${fmt(atFit)} (${atFit}s)`);

  // Binary search for the multiplier that lands exactly on Oslo's actual time.
  let lo = 0.5, hi = 4.0;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (predictAt(mid) < OSLO_2024_ACTUAL_S) lo = mid;
    else hi = mid;
  }
  const solved = (lo + hi) / 2;
  console.log(`multiplier that exactly matches Oslo's actual time: ${solved.toFixed(3)}x (predicted ${fmt(predictAt(solved))})`);

  // Refit using ONLY sustained-effort (race-like) runs -- tests whether
  // pooling easy/training-paced runs (run nowhere near max-sustainable
  // effort, so their baseline finish-time error is huge for reasons that
  // have nothing to do with terrain) is what's inflating the pooled fit
  // past what any single real race actually needs.
  const raceOnlyRaces = finishTimeRaces.filter((r) => r.isSustainedEffort);
  const raceOnlyIdx = finishTimeRaces.map((r, i) => (r.isSustainedEffort ? i : -1)).filter((i) => i >= 0);
  const raceOnlyDates = raceOnlyIdx.map((i) => raceDates[i]);
  const raceOnlyEffortRaces = raceOnlyIdx.map((i) => races[i]);
  console.log(`\n=== Refit restricted to ${raceOnlyRaces.length} sustained-effort (race-like) runs ===`);
  const raceOnlySafeFit = fitTauFInfWithSupportGate(raceOnlyEffortRaces, ceilingParams, { raceDates: raceOnlyDates });
  const raceOnlyMultiplierFit = fitUnpavedCostMultiplierAcrossRaces(raceOnlyRaces, raceOnlySafeFit.ceilingParams, commonInputs, {
    raceDates: raceOnlyDates,
  });
  if (raceOnlyMultiplierFit) {
    console.log(
      `Fitted unpavedCostMultiplier (race-only) = ${raceOnlyMultiplierFit.unpavedCostMultiplier.toFixed(3)}x (informative=${raceOnlyMultiplierFit.informativeRaceCount}, hitBoundary=${raceOnlyMultiplierFit.hitSearchBoundary ?? "no"})`,
    );
    const osloRaceOnlyIdx = raceOnlyRaces.findIndex((r) => r.id === OSLO_2024_ID);
    if (osloRaceOnlyIdx >= 0) {
      const atRaceOnlyFit = predictAt(raceOnlyMultiplierFit.unpavedCostMultiplier);
      console.log(`Oslo predicted @ race-only-fitted ${raceOnlyMultiplierFit.unpavedCostMultiplier.toFixed(2)}x: ${fmt(atRaceOnlyFit)} (${atRaceOnlyFit}s)`);
    }
  } else {
    console.log("Race-only multiplier fit returned null.");
  }
}

main();
