// Ad hoc diagnostic: why does the live app's "Theoretical ceiling" for
// Askerspurten (46:39, avg HR 162) read BELOW the athlete's stated LT2
// (165bpm)? Uses the athlete's own reported fitted values (f0=0.94,
// fInf=0.66, tau=220min) directly rather than re-fitting, so this
// reproduces exactly the curve their app is using.
//
// FINDING (confirmed 2026-08-29): the ceiling/boost/HR-calibration chain
// itself is correct -- on flat or uphill segments the model targets ~15.63
// W/kg, which is LT2 power (15.32) x the anaerobic-capacity boost (~1.02 at
// this duration), and the LOCKED HR calibration predicts ~166.5bpm there,
// genuinely above LT2 as intended. The reported ~162bpm AVERAGE is lower
// because Askerspurten has real elevation change (194m gain/190m loss) and
// ~14% of segments are descent-speed-capped (min power seen: 5.27 W/kg,
// a third of the flat/uphill max) -- the model needs less power to hit a
// capped downhill speed even at full effort, which is realistic, and pulls
// the course-wide time-weighted average down. The remaining gap to the
// athlete's real recorded 171.6bpm for this race is a genuine, separate
// question: whether real racers hold effort (not just minimize power) on
// descents, and/or whether the anaerobic-capacity boost is still too small
// at ~45min for this athlete specifically. Left as an open question for
// the athlete to decide how to handle -- see the conversation this was
// written for.
//
// Usage: npx tsx scripts/diagnoseAskerspurtenCeiling.ts

import { runPipeline } from "../src/gpx/pipeline.ts";
import { anaerobicCapacityMultiplier, ceilingPower, maxAerobicPower, type CeilingParams } from "../src/model/ceiling.ts";
import {
  buildThresholdPowerAnchorPoints,
  fitHrToPowerCalibrationAcrossRaces,
  fitHrToPowerCalibrationFromThresholds,
  predictHeartRateFromPower,
} from "../src/model/hrCalibration.ts";
import { buildEffortTrendPoints, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS,
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FatOxPoint,
} from "../src/ui/formInputs.ts";
import { buildChartPoints, summarizeChartPoints } from "../src/ui/chartData.ts";
import { fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";
import { fileURLToPath } from "node:url";

const BASE_URL = "http://localhost:3000";
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const ASKERSPURTEN_STRAVA_ID = 15777092101;
// A handful of real, varied-duration races from this athlete's Strava
// history (already used in predictARaces.ts) -- just enough to build a
// LOCKED (through LT2) race-pooled HR calibration, matching what the real
// app's "HR calibration: fit" actually produces, instead of the much
// weaker threshold-only version.
const CALIBRATION_POOL_STRAVA_IDS = [
  15777092101, // Askerspurten 10km itself
  14579457702, // Ecotrail 80
];

function formatHms(totalSeconds: number): string {
  const s = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}h` : ""}${m}m${sec.toString().padStart(2, "0")}s`;
}

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    /* cache-only is fine, this activity is already cached */
  }

  const fatOxPoints: FatOxPoint[] = [
    { paceMinPerKm: 60 / 8.5, heartRateBpm: 125, fatGPerMin: 0.4342, carbGPerMin: 2.301 },
    { paceMinPerKm: 60 / 10, heartRateBpm: 134, fatGPerMin: 0.481127, carbGPerMin: 2.549685 },
    { paceMinPerKm: 60 / 11.5, heartRateBpm: 143, fatGPerMin: 0.4693869, carbGPerMin: 2.9059515 },
    { paceMinPerKm: 60 / 12.5, heartRateBpm: 153, fatGPerMin: 0.352203, carbGPerMin: 3.750505 },
    { paceMinPerKm: 60 / 13.5, heartRateBpm: 160, fatGPerMin: 0.2586496, carbGPerMin: 4.483776 },
    { paceMinPerKm: 60 / 14.5, heartRateBpm: 165, fatGPerMin: 0.1355706, carbGPerMin: 5.069691 },
    { paceMinPerKm: 60 / 15.5, heartRateBpm: 170, fatGPerMin: 0, carbGPerMin: 5.9895165 },
  ];
  const foPeakGPerMin = Math.max(...fatOxPoints.map((p) => p.fatGPerMin));

  const formInputs = {
    ...DEFAULT_FORM_INPUTS,
    bodyMassKg: 85,
    vo2MaxHistory: [{ date: "2026-06-01", value: 54, source: "manual" as const }],
    lt2PaceMinPerKm: 4.25,
    lt2HeartRateBpm: 165,
    fatOxPoints,
    foPeakGPerMin,
    // The athlete's OWN reported fitted values -- not re-derived here, so
    // this reproduces exactly what their app is using.
    f0: 0.94,
    fInf: 0.66,
    tauMin: 220,
  };

  const baseCeilingParams: CeilingParams = resolveCeilingParams(formInputs);
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
  console.log(`Resolved LT2 fraction from 4:15/km pace @ VO2max 54: ${lt2Fraction.toFixed(4)} (default assumption is 0.85)`);
  console.log(`Ceiling params: f0=${baseCeilingParams.f0}, fInf=${baseCeilingParams.fInf}, tauMin=${baseCeilingParams.tauMin}, lt2Fraction=${baseCeilingParams.lt2Fraction?.toFixed(4)}, anaerobicCapacityMin=${formInputs.anaerobicCapacityMin}\n`);

  // Threshold-only HR calibration (LT1 + LT2 + fat-ox anchors) -- the
  // athlete's app additionally pools real race HR/power data, which we
  // don't have exact numbers for, so this is an approximation of their
  // real fitted line, not a byte-identical reproduction. Good enough to
  // see whether the ceiling ITSELF (before any HR conversion) is the
  // problem, which is the more fundamental question.
  const hrCalibration = fitHrToPowerCalibrationFromThresholds(
    { lt1Fraction, lt2Fraction, lt1HeartRateBpm: formInputs.lt1HeartRateBpm, lt2HeartRateBpm: formInputs.lt2HeartRateBpm, fatOxPoints: formInputs.fatOxPoints, walkMaxMs: formInputs.walkMaxMs },
    baseCeilingParams,
  );
  if (hrCalibration) {
    console.log(`Threshold-only HR calibration: HR ≈ ${hrCalibration.intercept.toFixed(1)} + ${hrCalibration.slope.toFixed(3)} × power(W/kg)\n`);
  }

  // The REAL locked-through-LT2 calibration, same mechanism runFitBatch.ts
  // uses -- pools real race (HR, power) samples, forced through the LT2
  // anchor exactly. This is what "HR calibration: fit" in the app actually
  // produces, unlike the threshold-only version above.
  const maxAerobic = maxAerobicPower(0, baseCeilingParams);
  const lt2Anchor = { hr: formInputs.lt2HeartRateBpm!, powerWPerKg: lt2Fraction * maxAerobic };
  console.log(`LT2 anchor for the locked calibration: ${lt2Anchor.hr}bpm @ ${lt2Anchor.powerWPerKg.toFixed(2)}W/kg`);
  console.log(`Sanity check -- predictHeartRateFromPower at exactly that power, before any race data blended in, must read back ${lt2Anchor.hr} exactly by construction.\n`);

  const poolRaces: EffortTrendPoint[][] = [];
  const poolDates: (Date | null)[] = [];
  for (const stravaId of CALIBRATION_POOL_STRAVA_IDS) {
    const { points: p } = await fetchActivityPoints(BASE_URL, cookie, stravaId);
    const c = runPipeline(p);
    if (!c.hasTimestamps) continue;
    // analyzeRun needs commonInputs -- reuse the same shape as below.
    const { analyzeRun } = await import("../src/model/analysis.ts");
    const analysis = analyzeRun(c.segments, {
      bodyMassKg: formInputs.bodyMassKg,
      ceilingParams: baseCeilingParams,
      substrateParams: resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction }),
      fueling: { intakeGPerH: formInputs.intakeGPerH },
      glycogenStoreG: resolveGlycogenStoreG(formInputs),
      walkMaxMs: formInputs.walkMaxMs,
      altitudeAdjustment: formInputs.altitudeAdjustment,
    });
    poolRaces.push(buildEffortTrendPoints(c.segments, analysis.segments, formInputs.altitudeAdjustment));
    poolDates.push(p[0]?.time ?? null);
  }
  const thresholdAnchors = buildThresholdPowerAnchorPoints(
    { lt1Fraction, lt2Fraction, lt1HeartRateBpm: formInputs.lt1HeartRateBpm, lt2HeartRateBpm: formInputs.lt2HeartRateBpm, fatOxPoints: formInputs.fatOxPoints, walkMaxMs: formInputs.walkMaxMs },
    baseCeilingParams,
  );
  const lockedCalibration = fitHrToPowerCalibrationAcrossRaces(poolRaces, baseCeilingParams, {
    raceDates: poolDates,
    thresholdAnchors,
    lockThroughLt2: lt2Anchor,
  });
  if (lockedCalibration) {
    console.log(`Locked (through-LT2) calibration: HR ≈ ${lockedCalibration.intercept.toFixed(1)} + ${lockedCalibration.slope.toFixed(3)} × power(W/kg), R²=${lockedCalibration.rSquared.toFixed(2)}`);
    console.log(`  Check: predictHeartRateFromPower(${lt2Anchor.powerWPerKg.toFixed(2)}) = ${predictHeartRateFromPower(lt2Anchor.powerWPerKg, lockedCalibration).toFixed(2)} (should be exactly ${lt2Anchor.hr})\n`);
  } else {
    console.log("Locked calibration: not enough pooled race data to fit (need more informative races in the pool).\n");
  }

  const { points } = await fetchActivityPoints(BASE_URL, cookie, ASKERSPURTEN_STRAVA_ID);
  const course = runPipeline(points);
  console.log(`Askerspurten: ${(course.totalDistance3D / 1000).toFixed(2)}km, ${course.totalElevationGain.toFixed(0)}m gain, ${course.totalElevationLoss.toFixed(0)}m loss.`);
  const realMovingTimeS = points[points.length - 1].time && points[0].time ? (points[points.length - 1].time!.getTime() - points[0].time!.getTime()) / 1000 : null;
  console.log(`Real recorded: ~${realMovingTimeS ? formatHms(realMovingTimeS) : "?"} elapsed, avg HR 171.6bpm (per Strava summary).\n`);

  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
  const solverInputs: SolverInputs = {
    segments: course.segments,
    bodyMassKg: formInputs.bodyMassKg,
    ceilingParams: baseCeilingParams,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: formInputs.foPeakGPerMin },
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(formInputs),
    walkMaxMs: formInputs.walkMaxMs,
    altitudeAdjustment: formInputs.altitudeAdjustment,
    anaerobicCapacityMin: formInputs.anaerobicCapacityMin,
  };

  const { theta, result } = findSustainableTheta(solverInputs);
  console.log(`findSustainableTheta: theta=${theta.toFixed(3)}, feasible=${result.feasible}, finishTimeS=${result.feasible ? formatHms(result.finishTimeS) : "n/a"}\n`);

  if (hrCalibration) {
    const chartPoints = buildChartPoints(course.segments, result.segments, { calibration: hrCalibration });
    const stats = summarizeChartPoints(chartPoints);
    console.log(`Predicted avg HR (threshold-only calibration): ~${stats.avgHrBpm?.toFixed(0)}bpm`);
  }
  if (lockedCalibration) {
    const chartPoints = buildChartPoints(course.segments, result.segments, { calibration: lockedCalibration });
    const stats = summarizeChartPoints(chartPoints);
    console.log(`Predicted avg HR (LOCKED-through-LT2 calibration, closer to the real app): ~${stats.avgHrBpm?.toFixed(0)}bpm\n`);
  }

  // Segment-by-segment breakdown of what's actually limiting theta: is the
  // raw duration-decay curve already below lt2Fraction by the finish (real
  // fatigue pull-down), or is theta itself being bisected down below 1
  // (feasibility -- fuel/glycogen), or is it genuinely at theta=1 the whole
  // way and the ceiling curve simply never reaches LT2 in the first place?
  const powers = result.segments.map((s) => s.grossPowerWPerKg);
  const minPower = Math.min(...powers);
  const maxPower = Math.max(...powers);
  const flatPower = powers.filter((p) => Math.abs(p - maxPower) < 0.05).length;
  console.log(
    `grossPowerWPerKg across all ${powers.length} segments: min=${minPower.toFixed(2)}, max=${maxPower.toFixed(2)}, ` +
      `${flatPower} segments (${((100 * flatPower) / powers.length).toFixed(0)}%) at/near the max (flat/uphill, uncapped) -- ` +
      `the rest sit lower, presumably descent-speed-capped downhill segments needing less power to hit their capped speed.\n`,
  );

  console.log("Segment samples through the race (elapsed min, fraction-of-VO2max ceiling, anaerobic boost, gross power W/kg, target W/kg):");
  const sampleIndices = [0, Math.floor(result.segments.length * 0.25), Math.floor(result.segments.length * 0.5), Math.floor(result.segments.length * 0.75), result.segments.length - 1];
  for (const i of sampleIndices) {
    const seg = result.segments[i];
    if (!seg) continue;
    const elapsedMin = (seg.cumulativeTimeS - seg.timeS) / 60;
    const fraction = ceilingPower({ tMin: elapsedMin, elapsedHours: elapsedMin / 60 }, baseCeilingParams) / (baseCeilingParams.vo2MaxMlPerKgPerMin! * 20.9 / 60);
    const boost = anaerobicCapacityMultiplier(elapsedMin, formInputs.anaerobicCapacityMin ?? 0);
    console.log(
      `  t=${elapsedMin.toFixed(1)}min  fraction=${fraction.toFixed(3)}  boost=${boost.toFixed(3)}  grossPower=${seg.grossPowerWPerKg.toFixed(2)}W/kg  target(theta×ceiling×boost)=${(theta * ceilingPower({ tMin: elapsedMin, elapsedHours: elapsedMin / 60 }, baseCeilingParams) * boost).toFixed(2)}W/kg`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
