// PLAN.md §14 Plan B, HR-prediction follow-up: the HR-calibration fix
// restricts fitting to long races, on the theory that short training runs
// never reach the higher effort fractions a long race does (a RANGE
// problem), not that their (power, HR) pairs are just badly time-aligned
// (a LAG problem the existing 75s trailing smoothing already partially
// addresses). This checks that theory two ways:
//
// 1. For a sample of short (excluded) and long (included) races, sweeps
//    both smoothing window AND an explicit lag offset (shifting HR
//    relative to power, on top of smoothing) to find each race's own
//    best achievable within-race correlation -- if short races' ceiling
//    correlation (at their OWN best lag/smoothing) is still low, lag
//    isn't the fix; if it jumps up, lag was the missing piece.
// 2. Directly compares the effort-fraction RANGE each duration bucket
//    actually covers -- if short races cluster at low effort fractions
//    while long races reach much higher ones, that's the range-coverage
//    problem no lag correction can manufacture around.
//
// Usage: npx tsx scripts/diagnoseHrLag.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const FINF = parseFloat(arg("fInf", "0.737"));
const TAU_MIN = parseFloat(arg("tauMin", "317"));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name ?? "", points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

function loadEdges(id: string): ValhallaSurfaceEdge[] | null {
  const p = `${SURFACE_CACHE_DIR}${id}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Trailing real-time-window mean of grossPowerWPerKg -- same mechanism as
 * hrCalibration.ts's own trailingMeanPower, reimplemented locally so this
 * script can sweep windowS as a free parameter. */
function trailingMeanPower(race: EffortTrendPoint[], windowS: number): number[] {
  const out: number[] = new Array(race.length);
  let lo = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < race.length; i++) {
    sum += race[i].grossPowerWPerKg;
    count++;
    while (race[i].tHours * 3600 - race[lo].tHours * 3600 > windowS) {
      sum -= race[lo].grossPowerWPerKg;
      count--;
      lo++;
    }
    out[i] = count > 0 ? sum / count : race[i].grossPowerWPerKg;
  }
  return out;
}

/** Pearson correlation between smoothed power at index i and HR at index
 * i+lagSteps (lag expressed in POINTS, not seconds, since points aren't
 * evenly time-spaced -- approximated via nearest index by elapsed time). */
function correlationAtLag(race: EffortTrendPoint[], smoothedPower: number[], lagSeconds: number): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < race.length; i++) {
    if (race[i].heartRateBpm === undefined) continue;
    const targetT = race[i].tHours * 3600 - lagSeconds; // HR now reflects power from `lagSeconds` ago
    // Find nearest point to targetT for the power side.
    let lo = 0;
    let hi = race.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (race[mid].tHours * 3600 < targetT) lo = mid + 1;
      else hi = mid;
    }
    if (lo < 0 || lo >= race.length) continue;
    xs.push(smoothedPower[lo]);
    ys.push(race[i].heartRateBpm!);
  }
  if (xs.length < 10) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
    syy += (ys[i] - meanY) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function bestCorrelation(race: EffortTrendPoint[]): { windowS: number; lagS: number; r: number } {
  let best = { windowS: 0, lagS: 0, r: -Infinity };
  for (const windowS of [0, 30, 60, 75, 90, 120, 180, 300]) {
    const smoothed = trailingMeanPower(race, windowS);
    for (const lagS of [0, 15, 30, 45, 60, 90, 120, 180]) {
      const r = correlationAtLag(race, smoothed, lagS);
      if (r !== null && r > best.r) best = { windowS, lagS, r };
    }
  }
  return best;
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX, fInf: FINF, tauMin: TAU_MIN };
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
    durationH: number;
    trimmed: EffortTrendPoint[];
  }
  const runs: Rec[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= MAX_ACTIVITIES) break;
    const { id, name, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const edges = loadEdges(id);
    if (!edges) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const segments = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    if (!effortTrendPoints.some((p) => p.heartRateBpm !== undefined)) continue;
    const trimmed = trimForPacingFit(effortTrendPoints);
    runs.push({ id, name, durationH: analysis.totalMovingTimeS / 3600, trimmed });
    used++;
  }
  console.log(`${runs.length} activities with heart rate data\n`);

  // Part 1: per-race best achievable correlation, sampling across the
  // duration spectrum (a handful of short, medium, and the long races).
  const shortSample = runs.filter((r) => r.durationH < 1.5).slice(0, 8);
  const mediumSample = runs.filter((r) => r.durationH >= 1.5 && r.durationH < 4).slice(0, 5);
  const longSample = runs.filter((r) => r.durationH >= 4);

  console.log("=== Part 1: best achievable within-race correlation (sweeping smoothing window x lag) ===");
  for (const [label, sample] of [
    ["short (<1.5h)", shortSample],
    ["medium (1.5-4h)", mediumSample],
    ["long (>=4h)", longSample],
  ] as const) {
    console.log(`\n-- ${label} --`);
    for (const r of sample) {
      const best = bestCorrelation(r.trimmed);
      console.log(
        `  ${r.name.padEnd(28)} ${r.durationH.toFixed(2).padStart(6)}h  best r=${best.r.toFixed(3)} at window=${best.windowS}s lag=${best.lagS}s`,
      );
    }
  }

  // Part 2: effort-fraction range covered by each duration bucket.
  console.log("\n=== Part 2: effort-fraction range covered, by duration bucket ===");
  const buckets: { label: string; filter: (h: number) => boolean }[] = [
    { label: "<1h", filter: (h) => h < 1 },
    { label: "1-2h", filter: (h) => h >= 1 && h < 2 },
    { label: "2-4h", filter: (h) => h >= 2 && h < 4 },
    { label: ">=4h", filter: (h) => h >= 4 },
  ];
  for (const b of buckets) {
    const pool = runs.filter((r) => b.filter(r.durationH));
    const fractions: number[] = [];
    for (const r of pool) {
      const smoothed = trailingMeanPower(r.trimmed, 75);
      for (let i = 0; i < r.trimmed.length; i++) {
        const p = r.trimmed[i];
        if (p.heartRateBpm === undefined) continue;
        const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, baseCeilingParams);
        if (ceiling > 0) fractions.push(smoothed[i] / ceiling);
      }
    }
    if (fractions.length === 0) {
      console.log(`  ${b.label.padEnd(6)}: no data`);
      continue;
    }
    fractions.sort((a, c) => a - c);
    const p10 = fractions[Math.floor(0.1 * fractions.length)];
    const p50 = fractions[Math.floor(0.5 * fractions.length)];
    const p90 = fractions[Math.floor(0.9 * fractions.length)];
    console.log(`  ${b.label.padEnd(6)}: n=${pool.length} races, ${fractions.length} points, p10=${p10.toFixed(3)} p50=${p50.toFixed(3)} p90=${p90.toFixed(3)}`);
  }
}

main();
