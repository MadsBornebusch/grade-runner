// PLAN.md §14 Plan B, HR-prediction follow-up: diagnoseHrLag.ts found the
// "restriction of range" explanation for why short races hurt the pooled
// HR calibration was WRONG (short races reach effort fractions AS HIGH OR
// HIGHER than long races, and correlate just as well within themselves).
// The likely real mechanism: fitHrToEffortCalibrationAcrossRaces has no
// start-of-race trim at all -- the first few minutes of EVERY race (HR
// still climbing from resting toward steady-state) are included in the
// fit. For a long race this warm-up transient is a tiny fraction of the
// usable window; for a short race it can be a large fraction, biasing
// the pooled fit toward "lower HR for a given effort" -- matching the
// observed under-prediction bias.
//
// This tests whether trimming a fixed number of minutes off the START of
// EVERY race (on top of the existing late-race drift cutoff), using the
// FULL, duration-unrestricted pool, matches or beats the current
// duration-gated fix on the metric that matters: held-out MAE in bpm for
// Ecotrail 80 and Soria Moria (leave-one-out, same discipline as
// evaluateHrPrediction.ts).
//
// Usage: npx tsx scripts/evaluateHrStartTrim.ts [--bodyMassKg=85] [--vo2Max=54] [--fInf=0.737] [--tauMin=317]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { predictHeartRateFromEffortFraction, type HrEffortCalibration } from "../src/model/hrCalibration.ts";
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

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const TARGET_RACES = ["14579457702", "18726525125"]; // Ecotrail 80, Soria Moria

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

/** Reimplements fitHrToEffortCalibrationAcrossRaces's core math with a
 * configurable absolute start-of-race trim (minutes) instead of the
 * duration-gate this session's earlier fix applied -- so the two
 * approaches can be compared head-to-head on the same held-out metric. */
function fitWithStartTrim(races: EffortTrendPoint[][], ceilingParams: CeilingParams, startTrimMinutes: number): HrEffortCalibration | null {
  interface Sample {
    hr: number;
    effortFraction: number;
    weight: number;
  }
  const samples: Sample[] = [];
  const contributingRaceIndices = new Set<number>();

  races.forEach((race, raceIndex) => {
    if (race.length === 0) return;
    const raceDurationHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
    if (!(raceDurationHours > 0)) return;
    const earlyCutoffHours = raceDurationHours * EARLY_WINDOW_FRACTION;
    const startCutoffHours = startTrimMinutes / 60;
    const smoothedPower = trailingMeanPower(race, POWER_SMOOTHING_WINDOW_S);

    race.forEach((p, i) => {
      if (p.tHours < startCutoffHours) return;
      if (p.tHours >= earlyCutoffHours) return;
      if (p.heartRateBpm === undefined) return;
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
      if (ceiling <= 0) return;
      const effortFraction = smoothedPower[i] / ceiling;
      samples.push({ hr: p.heartRateBpm, effortFraction, weight: p.dtS });
      contributingRaceIndices.add(raceIndex);
    });
  });

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
  return { slope, intercept, rSquared, pointCount: samples.length, raceCount: contributingRaceIndices.size };
}

function evalMae(calibration: HrEffortCalibration | null, bins: { effortFraction: number[]; hr: number[] }[]): { mae: number; bias: number } | null {
  if (!calibration) return null;
  const errors: number[] = [];
  for (const b of bins) {
    if (b.hr.length === 0 || b.effortFraction.length === 0) continue;
    const meanEffort = b.effortFraction.reduce((a, c) => a + c, 0) / b.effortFraction.length;
    const meanHr = b.hr.reduce((a, c) => a + c, 0) / b.hr.length;
    errors.push(predictHeartRateFromEffortFraction(meanEffort, calibration) - meanHr);
  }
  if (errors.length === 0) return null;
  return {
    mae: errors.reduce((a, c) => a + Math.abs(c), 0) / errors.length,
    bias: errors.reduce((a, c) => a + c, 0) / errors.length,
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
    date: Date | null;
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
    const firstTimed = points.find((p) => p.time !== null);
    const trimmed = trimForPacingFit(effortTrendPoints);
    runs.push({ id, name, date: firstTimed?.time ?? null, effortTrendPoints, durationH: analysis.totalMovingTimeS / 3600, trimmed });
    used++;
  }
  console.log(`${runs.length} activities with heart rate data\n`);

  for (const targetId of TARGET_RACES) {
    const target = runs.find((r) => r.id === targetId);
    if (!target) continue;
    console.log(`=== ${target.name} (${target.durationH.toFixed(2)}h) ===`);
    const training = runs.filter((r) => r.id !== targetId);

    const totalHours = target.trimmed[target.trimmed.length - 1].tHours;
    const binCount = Math.ceil((totalHours * 60) / BIN_MINUTES);
    const bins: { effortFraction: number[]; hr: number[] }[] = Array.from({ length: binCount }, () => ({ effortFraction: [], hr: [] }));
    for (const p of target.trimmed) {
      const binIdx = Math.min(binCount - 1, Math.floor((p.tHours * 60) / BIN_MINUTES));
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, baseCeilingParams);
      if (ceiling > 0) bins[binIdx].effortFraction.push(p.grossPowerWPerKg / ceiling);
      if (p.heartRateBpm !== undefined) bins[binIdx].hr.push(p.heartRateBpm);
    }

    const longOnly = training.filter((r) => r.durationH * 60 >= TAU_MIN);
    console.log(`  (long-only pool for combined test: ${longOnly.length} races)`);

    for (const [poolLabel, pool] of [
      ["full pool", training],
      ["long-only pool", longOnly],
    ] as const) {
      for (const startTrimMinutes of [0, 5, 10, 15, 20, 30]) {
        const calibration = fitWithStartTrim(
          pool.map((r) => r.effortTrendPoints),
          baseCeilingParams,
          startTrimMinutes,
        );
        const result = evalMae(calibration, bins);
        if (!result || !calibration) {
          console.log(`  [${poolLabel}] startTrim=${startTrimMinutes}min: no result`);
          continue;
        }
        console.log(
          `  [${poolLabel.padEnd(14)}] startTrim=${String(startTrimMinutes).padStart(2)}min: MAE=${result.mae.toFixed(2)}bpm bias=${result.bias >= 0 ? "+" : ""}${result.bias.toFixed(2)}bpm ` +
            `(R^2=${calibration.rSquared.toFixed(3)} races=${calibration.raceCount} points=${calibration.pointCount})`,
        );
      }
    }
    console.log();
  }
}

main();
