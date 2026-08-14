// Reproduces computeChosenTheta/fitPacingMarginAcrossRaces exactly as
// runFitBatch.ts calls them, against real cached data for the named races
// since Saksumdal 17 (2024-09-07) -- built while investigating a report of
// "Currently applied" showing "not fit yet" while the fit's own result
// panel showed a successful 6-race fit at the same time. This script
// confirmed the underlying math was fine (chosenTheta values here land
// within a few points of the real app's own numbers, using generic
// defaults instead of the athlete's real physiology). The actual bug
// turned out to be upstream in App.tsx: every onApply* callback did
// setFormInputs({ ...formInputs, x }) with formInputs captured once per
// render, and runFitBatch calls several of them synchronously in a row
// (surface cost, HR calibration, pacing margin, then tau/fInf) -- React
// batches all of those into one re-render, and since each call replaced the
// pending state with a snapshot of the SAME stale formInputs rather than
// building on the previous call's update, only the last call in the
// sequence (tau/fInf) actually stuck. Fixed by switching every onApply*
// callback to a functional update. Kept as a reference for how to
// reproduce this fit's real numbers offline.
//
// Usage: npx tsx scripts/diagnosePacingMarginGap.ts

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { fitHrToEffortCalibrationAcrossRaces } from "../src/model/hrCalibration.ts";
import { buildEffortTrendPoints, fitTauFInfWithSupportGate } from "../src/model/pacingFit.ts";
import { computeChosenTheta, fitPacingMarginAcrossRaces } from "../src/model/pacingMarginFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams } from "../src/ui/formInputs.ts";

const REAL_VO2_MAX = 54;
const REAL_BODY_MASS_KG = 85;
const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

const NAMED_RACE_IDS = [
  "12347317200", // Saksumdal 17 2024
  "12524841443", // Oslo Trail Challenge 2024
  "15714210750", // Saksumdal 17 2025
  "14579457702", // Ecotrail 80
  "15777092101", // Askerspurten 10km
  "15881389598", // Ås Backyard ultra
  "18726525125", // Soria Moria
];

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function main() {
  const formInputs = DEFAULT_FORM_INPUTS;
  const ceilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: REAL_VO2_MAX };
  const commonInputs = {
    bodyMassKg: REAL_BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    walkMaxMs: formInputs.walkMaxMs,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  // Build a broad training pool (everything) to get a realistic tau/fInf +
  // HR calibration fit, matching what the real app would use.
  const files = readdirSync(CACHE_DIR).filter((f: string) => f.startsWith("activity-") && f.endsWith(".json"));
  const races: ReturnType<typeof buildEffortTrendPoints>[] = [];
  const raceDates: (Date | null)[] = [];
  const namedRaceTrendPoints: Record<string, ReturnType<typeof buildEffortTrendPoints>> = {};
  const namedRaceMeta: Record<string, { name: string; totalHours: number }> = {};

  for (const file of files) {
    const id = file.match(/activity-([^/]+)\.json/)?.[1] ?? file;
    const raw = JSON.parse(readFileSync(`${CACHE_DIR}${file}`, "utf8")) as CachedActivityPoints;
    const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (!points.some((p) => p.time !== null)) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const analysis = analyzeRun(course.segments, { ...commonInputs, ceilingParams, glycogenStoreG: 500 });
    const trendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
    if (analysis.totalMovingTimeS >= 3600) {
      races.push(trendPoints);
      raceDates.push(points.find((p) => p.time !== null)?.time ?? null);
    }
    if (NAMED_RACE_IDS.includes(id)) {
      namedRaceTrendPoints[id] = trendPoints;
      namedRaceMeta[id] = { name: raw.name, totalHours: analysis.totalMovingTimeS / 3600 };
    }
  }

  console.log(`Training pool: ${races.length} runs >= 1h\n`);
  const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates });
  console.log(`tau/fInf tier: ${safeFit.tier}\n`);

  const hrCalibrationFit = fitHrToEffortCalibrationAcrossRaces(races, safeFit.ceilingParams, { raceDates });
  console.log(`HR calibration: ${hrCalibrationFit ? `slope=${hrCalibrationFit.slope.toFixed(5)} intercept=${hrCalibrationFit.intercept.toFixed(3)} R²=${hrCalibrationFit.rSquared.toFixed(2)}` : "null"}\n`);

  if (!hrCalibrationFit) {
    console.log("No calibration -- can't test computeChosenTheta.");
    return;
  }

  console.log("Per named race, computeChosenTheta result:");
  const confirmedTrendPoints = [];
  const confirmedNames = [];
  for (const id of NAMED_RACE_IDS) {
    const trendPoints = namedRaceTrendPoints[id];
    const meta = namedRaceMeta[id];
    if (!trendPoints) {
      console.log(`  ${id} -- NOT FOUND IN CACHE (would not appear in confirmedRaceTrendPoints at all)`);
      continue;
    }
    const chosenTheta = computeChosenTheta(trendPoints, hrCalibrationFit);
    console.log(`  ${meta.name.padEnd(30)} ${meta.totalHours.toFixed(2)}h  chosenTheta=${chosenTheta === null ? "NULL" : chosenTheta.toFixed(3)}`);
    confirmedTrendPoints.push(trendPoints);
    confirmedNames.push(meta.name);
  }

  console.log();
  const marginFit = fitPacingMarginAcrossRaces(confirmedTrendPoints, confirmedNames, hrCalibrationFit);
  console.log(marginFit ? `Margin fit SUCCEEDED: raceCount=${marginFit.raceCount}` : "Margin fit returned NULL (fewer than MIN_MARGIN_FIT_RACES usable)");
}

main();
