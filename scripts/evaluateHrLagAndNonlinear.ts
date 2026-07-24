// PLAN.md §14 Plan B, HR-prediction follow-up: two direct questions about
// the shipped calibration (duration gate + 15min start trim):
// 1. Does adding an explicit LAG (shifting HR relative to smoothed power
//    by a fixed offset, on top of the existing trailing-mean smoothing)
//    improve held-out prediction further?
// 2. Is the true HR<->effort relationship nonlinear -- does a quadratic
//    term (fit via weighted least squares, inverted via the quadratic
//    formula) beat the current linear model on HELD-OUT bpm error, or
//    does it just fit the training pool better while overfitting two
//    races' worth of real data?
//
// Both measured on the same held-out MAE metric as every other check in
// this investigation (Ecotrail 80, Soria Moria, leave-one-out), not R^2.
//
// Usage: npx tsx scripts/evaluateHrLagAndNonlinear.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { weightedLeastSquares } from "../src/model/linearSolve.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const FINF = parseFloat(arg("fInf", "0.737"));
const TAU_MIN = parseFloat(arg("tauMin", "317"));
const BIN_MINUTES = 30;
const EARLY_WINDOW_FRACTION = 0.65;
const POWER_SMOOTHING_WINDOW_S = 75;
const START_TRIM_MINUTES = 15;

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const TARGET_RACES = ["14579457702", "18726525125"];

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

function trailingMeanPower(race: EffortTrendPoint[], windowS: number): number[] {
  const out: number[] = new Array(race.length);
  let lo = 0,
    sum = 0,
    count = 0;
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

/** Nearest-by-elapsed-time lookup: returns the index whose tHours is
 * closest to targetHours (binary search, since points are time-ordered). */
function nearestIndexByTime(race: EffortTrendPoint[], targetHours: number): number {
  let lo = 0;
  let hi = race.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (race[mid].tHours < targetHours) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Sample {
  hr: number;
  effortFraction: number;
  weight: number;
}

/** Builds the (HR, effortFraction) sample pool for a set of races -- same
 * gates as production (duration already pre-filtered by caller, start
 * trim, late-drift cutoff), with an added explicit lagSeconds: HR at
 * time t is paired with smoothed power at time (t - lagSeconds), i.e. HR
 * is modeled as responding to power from lagSeconds ago, on top of
 * whatever the trailing smoothing window already captures. */
function buildSamples(races: EffortTrendPoint[][], ceilingParams: CeilingParams, lagSeconds: number): Sample[] {
  const samples: Sample[] = [];
  for (const race of races) {
    if (race.length === 0) continue;
    const raceDurationHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
    if (!(raceDurationHours > 0)) continue;
    const earlyCutoffHours = raceDurationHours * EARLY_WINDOW_FRACTION;
    const startCutoffHours = START_TRIM_MINUTES / 60;
    const smoothedPower = trailingMeanPower(race, POWER_SMOOTHING_WINDOW_S);
    const lagHours = lagSeconds / 3600;

    race.forEach((p, i) => {
      if (p.tHours < startCutoffHours) return;
      if (p.tHours >= earlyCutoffHours) return;
      if (p.heartRateBpm === undefined) return;
      const powerIdx = nearestIndexByTime(race, p.tHours - lagHours);
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
      if (ceiling <= 0) return;
      samples.push({ hr: p.heartRateBpm, effortFraction: smoothedPower[powerIdx] / ceiling, weight: p.dtS });
    });
  }
  return samples;
}

interface LinearCalib {
  kind: "linear";
  slope: number;
  intercept: number;
  rSquared: number;
}
interface QuadraticCalib {
  kind: "quadratic";
  a: number; // effortFraction = a*hr^2 + b*hr + c
  b: number;
  c: number;
  rSquared: number;
}

function fitLinear(samples: Sample[]): LinearCalib | null {
  if (samples.length < 10) return null;
  const sumW = samples.reduce((s, p) => s + p.weight, 0);
  if (!(sumW > 0)) return null;
  const meanHr = samples.reduce((s, p) => s + p.weight * p.hr, 0) / sumW;
  const meanEffort = samples.reduce((s, p) => s + p.weight * p.effortFraction, 0) / sumW;
  let sXY = 0,
    sXX = 0,
    sYY = 0;
  for (const p of samples) {
    const dHr = p.hr - meanHr;
    const dEffort = p.effortFraction - meanEffort;
    sXY += p.weight * dHr * dEffort;
    sXX += p.weight * dHr * dHr;
    sYY += p.weight * dEffort * dEffort;
  }
  if (!(sXX > 0)) return null;
  const slope = sXY / sXX;
  const intercept = meanEffort - slope * meanHr;
  const rSquared = sYY > 0 ? (sXY * sXY) / (sXX * sYY) : 0;
  return { kind: "linear", slope, intercept, rSquared };
}

function fitQuadratic(samples: Sample[]): QuadraticCalib | null {
  if (samples.length < 15) return null;
  const x = samples.map((s) => [s.hr * s.hr, s.hr, 1]);
  const y = samples.map((s) => s.effortFraction);
  const w = samples.map((s) => s.weight);
  const result = weightedLeastSquares(x, y, w);
  if (!result) return null;
  const [a, b, c] = result.coefficients;
  return { kind: "quadratic", a, b, c, rSquared: result.rSquared };
}

function predictHrLinear(effortFraction: number, calib: LinearCalib): number {
  return (effortFraction - calib.intercept) / calib.slope;
}

/** Inverts effortFraction = a*hr^2 + b*hr + c for hr via the quadratic
 * formula, picking the root closest to a plausible HR range (100-200bpm)
 * -- a quadratic has up to two solutions, only one is physiologically
 * sensible. */
function predictHrQuadratic(effortFraction: number, calib: QuadraticCalib): number | null {
  const { a, b, c } = calib;
  const cc = c - effortFraction;
  if (Math.abs(a) < 1e-12) return cc !== 0 ? -cc / b : null; // degenerates to linear
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const r1 = (-b + sqrtDisc) / (2 * a);
  const r2 = (-b - sqrtDisc) / (2 * a);
  const plausible = (r: number) => r > 80 && r < 220;
  if (plausible(r1) && plausible(r2)) return Math.abs(r1 - 150) < Math.abs(r2 - 150) ? r1 : r2;
  if (plausible(r1)) return r1;
  if (plausible(r2)) return r2;
  return null;
}

function evalMae(predictFn: (effortFraction: number) => number | null, bins: { effortFraction: number[]; hr: number[] }[]) {
  const errors: number[] = [];
  for (const b of bins) {
    if (b.hr.length === 0 || b.effortFraction.length === 0) continue;
    const meanEffort = b.effortFraction.reduce((a, c) => a + c, 0) / b.effortFraction.length;
    const meanHr = b.hr.reduce((a, c) => a + c, 0) / b.hr.length;
    const predicted = predictFn(meanEffort);
    if (predicted === null) continue;
    errors.push(predicted - meanHr);
  }
  if (errors.length === 0) return null;
  return {
    mae: errors.reduce((a, c) => a + Math.abs(c), 0) / errors.length,
    bias: errors.reduce((a, c) => a + c, 0) / errors.length,
    n: errors.length,
  };
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
    effortTrendPoints: EffortTrendPoint[];
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
    runs.push({ id, name, effortTrendPoints, durationH: analysis.totalMovingTimeS / 3600, trimmed });
    used++;
  }
  console.log(`${runs.length} activities with heart rate data\n`);

  for (const targetId of TARGET_RACES) {
    const target = runs.find((r) => r.id === targetId);
    if (!target) continue;
    console.log(`=== ${target.name} (${target.durationH.toFixed(2)}h) ===`);

    const training = runs.filter((r) => r.id !== targetId);
    const longOnly = training.filter((r) => r.durationH * 60 >= TAU_MIN).map((r) => r.effortTrendPoints);
    console.log(`  long-only training pool: ${longOnly.length} races`);

    const totalHours = target.trimmed[target.trimmed.length - 1].tHours;
    const binCount = Math.ceil((totalHours * 60) / BIN_MINUTES);
    const bins: { effortFraction: number[]; hr: number[] }[] = Array.from({ length: binCount }, () => ({ effortFraction: [], hr: [] }));
    for (const p of target.trimmed) {
      const binIdx = Math.min(binCount - 1, Math.floor((p.tHours * 60) / BIN_MINUTES));
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, baseCeilingParams);
      if (ceiling > 0) bins[binIdx].effortFraction.push(p.grossPowerWPerKg / ceiling);
      if (p.heartRateBpm !== undefined) bins[binIdx].hr.push(p.heartRateBpm);
    }

    console.log("\n  -- Part 1: explicit lag on top of trim+duration-gate (linear model) --");
    for (const lagSeconds of [0, 15, 30, 45, 60, 90, 120]) {
      const samples = buildSamples(longOnly, baseCeilingParams, lagSeconds);
      const calib = fitLinear(samples);
      if (!calib) {
        console.log(`    lag=${lagSeconds}s: no result`);
        continue;
      }
      const result = evalMae((ef) => predictHrLinear(ef, calib), bins);
      console.log(
        `    lag=${String(lagSeconds).padStart(3)}s: MAE=${result?.mae.toFixed(2) ?? "--"}bpm bias=${result ? (result.bias >= 0 ? "+" : "") + result.bias.toFixed(2) : "--"}bpm R^2=${calib.rSquared.toFixed(3)} n=${samples.length}`,
      );
    }

    console.log("\n  -- Part 2: linear vs quadratic (both at lag=0, trim+duration-gate) --");
    const samples = buildSamples(longOnly, baseCeilingParams, 0);
    const linearCalib = fitLinear(samples);
    const quadCalib = fitQuadratic(samples);
    if (linearCalib) {
      const r = evalMae((ef) => predictHrLinear(ef, linearCalib), bins);
      console.log(`    linear:    MAE=${r?.mae.toFixed(2) ?? "--"}bpm bias=${r ? (r.bias >= 0 ? "+" : "") + r.bias.toFixed(2) : "--"}bpm R^2=${linearCalib.rSquared.toFixed(3)} (n=${r?.n})`);
    }
    if (quadCalib) {
      const r = evalMae((ef) => predictHrQuadratic(ef, quadCalib), bins);
      console.log(
        `    quadratic: MAE=${r?.mae.toFixed(2) ?? "--"}bpm bias=${r ? (r.bias >= 0 ? "+" : "") + r.bias.toFixed(2) : "--"}bpm R^2=${quadCalib.rSquared.toFixed(3)} (n=${r?.n}, evaluable bins with a real root)`,
      );
    } else {
      console.log("    quadratic: fit returned null");
    }
    console.log();
  }
}

main();
