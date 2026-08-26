// Ad hoc, one-off backtest for a user request: "test the prediction of my
// A-races this year and last year" -- fit the athlete model on a training
// window ending a week before each race, then predict the race exactly the
// way the app's Results page would (Theoretical ceiling, Chosen pacing,
// Best demonstrated, avg pace/GAP/estimated HR), and compare to what
// actually happened.
//
// Same "no access to localStorage" limitation backtestFinishTime.ts already
// documents: bodyMassKg/VO2max/LT1/LT2/foPeakGPerMin/etc. are
// DEFAULT_FORM_INPUTS, not this athlete's real saved profile -- only what's
// genuinely fit from Strava data (tau/fInf, HR-power calibration, pacing
// margin) reflects them specifically. intakeGPerH is overridden to 80 per
// the user's explicit request. anaerobicCapacityMin is left at its real
// app default (1 min) -- negligible at these durations (~8-14h) per its own
// regression tests, but stated here for reproducibility.
//
// "Confirmed races" (StoredRun.raceTag === "race") aren't recoverable from
// Strava alone -- that tag lives in the browser's IndexedDB. Approximated
// here by filtering each training window to non-generic-Strava-title runs
// (raceCandidates.ts's own heuristic) and applying judgment (see
// CONFIRMED_RACE_NAMES below) -- printed explicitly so it can be corrected.
//
// Runs entirely offline against .strava-cache/ (no vercel dev / live Strava
// needed) as long as every selected candidate's points are already cached;
// falls back to a live fetch (needs .strava-session.local + vercel dev)
// only for a cache miss.
//
// Usage: npx tsx scripts/predictARaces.ts

import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { maxAerobicPower, type CeilingParams } from "../src/model/ceiling.ts";
import {
  buildThresholdPowerAnchorPoints,
  fitHrToPowerCalibrationAcrossRaces,
  fitHrToPowerCalibrationFromThresholds,
  type HrPowerCalibration,
} from "../src/model/hrCalibration.ts";
import {
  buildEffortTrendPoints,
  fitTauFInfWithSupportGate,
  type EffortTrendPoint,
} from "../src/model/pacingFit.ts";
import {
  fitPacingMarginAcrossRaces,
  predictBestDemonstratedTheta,
  predictMarginTheta,
  MIN_MARGIN_FIT_RACES,
  type PacingMarginCurve,
} from "../src/model/pacingMarginFit.ts";
import { findFlatPacedFinishTime, findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS,
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FatOxPoint,
} from "../src/ui/formInputs.ts";
import { buildChartPoints, summarizeChartPoints } from "../src/ui/chartData.ts";
import { fileURLToPath } from "node:url";
import { backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = "http://localhost:3000";
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));

function formatHms(totalSeconds: number): string {
  const s = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${totalSeconds < 0 ? "-" : ""}${h}h${m.toString().padStart(2, "0")}m${sec.toString().padStart(2, "0")}s`;
}

function fmtPace(minPerKm: number | null): string {
  if (minPerKm === null) return "--:--/km";
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

interface BacktestConfig {
  label: string;
  targetStravaId: number;
  trainingSince: string;
  trainingUntil: string; // exclusive
  confirmedRaceNames: string[]; // substring match, case-insensitive
}

const CONFIGS: BacktestConfig[] = [
  {
    label: "2025 A-race: Ecotrail 80",
    targetStravaId: 14579457702,
    trainingSince: "2023-01-01",
    trainingUntil: "2025-05-17",
    confirmedRaceNames: ["Saksumdal 17", "Oslo Trail Challenge 55"],
  },
  {
    label: "2026 A-race: Soria Moria til Verdens Ende",
    targetStravaId: 18726525125,
    trainingSince: "2024-01-01",
    trainingUntil: "2026-05-23",
    confirmedRaceNames: ["Saksumdal 17", "Oslo Trail Challenge 55", "Ecotrail 80", "Askerspurten 10"],
    // Deliberately excluded from confirmedRaceNames: "Ås Backyard ultra"
    // (enforced-rest loop format, not continuous effort -- pacingMarginFit.ts's
    // own doc warns against conflating this with a real race) and
    // "Sommerafslutning..." (reads as a club social run, not a timed race).
  },
];

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    console.log("No .strava-session.local -- proceeding cache-only; a cache miss will throw.\n");
  }

  // Real athlete data supplied by the user (2026-08-24): 85kg, VO2max 54,
  // threshold pace 4:15/km @ 165bpm (locked as LT2), and a 7-point fat-ox
  // test. foPeakGPerMin auto-filled from the highest measured fat rate
  // (0.481 g/min @ 10km/h), matching InputsPanel.tsx's own auto-fill note.
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
    intakeGPerH: 80,
    bodyMassKg: 85,
    vo2MaxHistory: [{ date: "2026-06-01", value: 54, source: "manual" as const }],
    lt2PaceMinPerKm: 4.25, // 4:15/km
    lt2HeartRateBpm: 165,
    fatOxPoints,
    foPeakGPerMin,
  };
  const baseCeilingParams: CeilingParams = resolveCeilingParams(formInputs);
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...formInputs, lt1Fraction, lt2Fraction });
  const substrateParams = { x0, k, intensityIsAbsolutePower, foPeakGPerMin: formInputs.foPeakGPerMin };
  const commonInputs = {
    bodyMassKg: formInputs.bodyMassKg,
    substrateParams,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(formInputs),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
    anaerobicCapacityMin: formInputs.anaerobicCapacityMin,
  };

  console.log("=".repeat(100));
  console.log(
    `Athlete profile: ${formInputs.bodyMassKg}kg, VO2max ${formInputs.vo2MaxHistory[0].value}, LT2 pace ${formInputs.lt2PaceMinPerKm}min/km @ ${formInputs.lt2HeartRateBpm}bpm, ` +
      `${formInputs.fatOxPoints.length}-point fat-ox curve, foPeak=${formInputs.foPeakGPerMin.toFixed(3)}g/min, ${formInputs.intakeGPerH}g/h carb intake.`,
  );
  console.log(
    "Everything else (walk speed, glycogen g/kg, force-walk grade, altitude adjustment) is DEFAULT_FORM_INPUTS -- not verified against your real settings.",
  );
  console.log(
    "tau/fInf, HR-power calibration, and pacing margin are genuinely fit from your Strava data below (using this profile as the ceiling/substrate model).",
  );
  console.log("=".repeat(100) + "\n");

  for (const cfg of CONFIGS) {
    await runBacktest(cfg, cookie, formInputs, baseCeilingParams, lt1Fraction, lt2Fraction, commonInputs);
  }
}

async function runBacktest(
  cfg: BacktestConfig,
  cookie: string,
  formInputs: typeof DEFAULT_FORM_INPUTS,
  baseCeilingParams: CeilingParams,
  lt1Fraction: number,
  lt2Fraction: number,
  commonInputs: Omit<SolverInputs, "segments" | "ceilingParams" | "descentExposureBasis" | "surfaceCostMultipliers">,
) {
  console.log("\n" + "#".repeat(100));
  console.log(`# ${cfg.label}`);
  console.log("#".repeat(100));

  const sinceDate = new Date(cfg.trainingSince);
  const untilDate = new Date(cfg.trainingUntil);
  const allRuns = await backfill(BASE_URL, cookie, sinceDate, { offline: true });
  const trainingRuns = allRuns.filter((r) => r.date && new Date(r.date) >= sinceDate && new Date(r.date) < untilDate);
  console.log(`Training window: [${cfg.trainingSince}, ${cfg.trainingUntil}) -- ${trainingRuns.length} candidate runs.`);

  // Pool EVERY training-window run whose points are already cached (not
  // just suggestRunsForFit's curated ~10) -- mirrors runFitBatch.ts's real
  // in-app behavior (every "ready" run feeds the fit, not a hand-picked
  // subset), and a first pass with only the curated subset produced a
  // visibly under-supported, implausible fit (tau=27min, chosen theta>1 on
  // some races) -- too few, too noisy a sample. A cache miss is skipped
  // silently (would need a live Strava fetch this script avoids by
  // design); see the summary counts below for how much that cost.
  const confirmedRuns = trainingRuns.filter((r) => cfg.confirmedRaceNames.some((n) => r.name.toLowerCase().includes(n.toLowerCase())));
  console.log(`Treating as confirmed races for the margin fit: ${confirmedRuns.map((r) => `${r.name} (${r.date?.slice(0, 10)})`).join(", ") || "(none)"}`);
  console.log(`Reading cached GPS data for up to ${trainingRuns.length} training candidates...`);

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
  const confirmedTrendPoints: EffortTrendPoint[][] = [];
  const confirmedNames: string[] = [];
  let cacheMisses = 0;

  for (const run of trainingRuns) {
    if (run.stravaId === undefined) continue;
    let points;
    try {
      ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    } catch {
      cacheMisses++;
      continue;
    }
    for (const legPoints of splitAtTransitGaps(points)) {
      const course = runPipeline(legPoints);
      if (!course.hasTimestamps) continue;
      const analysis = analyzeRun(course.segments, { ...commonInputs, ceilingParams: baseCeilingParams });
      const trend = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      const isConfirmed = cfg.confirmedRaceNames.some((n) => run.name.toLowerCase().includes(n.toLowerCase()));
      if (isConfirmed) {
        confirmedTrendPoints.push(trend);
        confirmedNames.push(run.name);
      }
      if (analysis.totalMovingTimeS >= 60 * 60) {
        races.push(trend);
        raceDates.push(run.date ? new Date(run.date) : null);
      }
    }
  }
  console.log(
    `${races.length} training races (>=1h) usable for tau/fInf; ${confirmedTrendPoints.length} confirmed races for the margin fit ` +
      `(${cacheMisses} candidate runs skipped -- not already cached locally).\n`,
  );

  const safeFit = fitTauFInfWithSupportGate(races, baseCeilingParams, { raceDates });
  const fittedCeilingParams = safeFit.ceilingParams;
  console.log(
    `tau/fInf fit tier: ${safeFit.tier}` +
      (safeFit.tier !== "defaults"
        ? ` -- tauMin=${fittedCeilingParams.tauMin}, fInf=${fittedCeilingParams.fInf ?? baseCeilingParams.fInf}`
        : ` -- holding defaults tauMin=${baseCeilingParams.tauMin}, fInf=${baseCeilingParams.fInf}`),
  );

  const thresholdAnchors = buildThresholdPowerAnchorPoints(
    { lt1Fraction, lt2Fraction, lt1HeartRateBpm: formInputs.lt1HeartRateBpm, lt2HeartRateBpm: formInputs.lt2HeartRateBpm, fatOxPoints: formInputs.fatOxPoints, walkMaxMs: formInputs.walkMaxMs },
    fittedCeilingParams,
  );
  const maxAerobic = maxAerobicPower(0, fittedCeilingParams);
  const lt2Anchor =
    formInputs.lt2HeartRateBpm !== null && maxAerobic > 0
      ? { hr: formInputs.lt2HeartRateBpm, powerWPerKg: lt2Fraction * maxAerobic }
      : undefined;
  const hrCalibrationFit = fitHrToPowerCalibrationAcrossRaces(races, fittedCeilingParams, {
    raceDates,
    thresholdAnchors,
    lockThroughLt2: lt2Anchor,
  });
  if (hrCalibrationFit) {
    console.log(
      `HR calibration: HR ≈ ${hrCalibrationFit.intercept.toFixed(1)} + ${hrCalibrationFit.slope.toFixed(3)} × power(W/kg), ` +
        `R²=${hrCalibrationFit.rSquared.toFixed(2)} (${hrCalibrationFit.pointCount} points, ${hrCalibrationFit.raceCount} races).`,
    );
  } else {
    console.log("HR calibration: no usable fit (no HR data in the training pool).");
  }

  const marginCalibration: HrPowerCalibration | null =
    hrCalibrationFit ??
    fitHrToPowerCalibrationFromThresholds(
      { lt1Fraction, lt2Fraction, lt1HeartRateBpm: formInputs.lt1HeartRateBpm, lt2HeartRateBpm: formInputs.lt2HeartRateBpm, fatOxPoints: formInputs.fatOxPoints, walkMaxMs: formInputs.walkMaxMs },
      fittedCeilingParams,
    );
  const marginFit = marginCalibration ? fitPacingMarginAcrossRaces(confirmedTrendPoints, confirmedNames, marginCalibration, fittedCeilingParams) : null;
  if (marginFit) {
    console.log(
      `Pacing margin fit: marginFInf=${marginFit.marginFInf.toFixed(3)}, marginTauHours=${marginFit.marginTauHours.toFixed(2)}, ` +
        `bestUpsideOffset=${marginFit.bestUpsideOffset.toFixed(3)} (${marginFit.raceCount} races, ${marginFit.minDurationHours.toFixed(1)}-${marginFit.maxDurationHours.toFixed(1)}h span).`,
    );
    for (const p of marginFit.perRace) {
      console.log(
        `    ${p.name}: ${p.durationHours.toFixed(2)}h, chosen theta=${p.chosenTheta?.toFixed(2) ?? "n/a"}, predicted=${p.predictedTheta?.toFixed(2) ?? "n/a"}`,
      );
    }
  } else {
    console.log(
      `Pacing margin fit: NOT AVAILABLE (needs >=${MIN_MARGIN_FIT_RACES} confirmed races with usable HR; had ${confirmedTrendPoints.length}) -- ` +
        `the app would show only "Theoretical ceiling" here, no "Chosen pacing"/"Best demonstrated".`,
    );
  }

  console.log(`\nFetching target race data (stravaId=${cfg.targetStravaId})...`);
  const { name: targetName, points: targetPoints } = await fetchActivityPoints(BASE_URL, cookie, cfg.targetStravaId);
  const targetCourse = runPipeline(targetPoints);
  const targetAnalysis = analyzeRun(targetCourse.segments, { ...commonInputs, ceilingParams: fittedCeilingParams });
  const actualFinishS = targetAnalysis.totalMovingTimeS;
  const actualAvgHr = targetCourse.segments.filter((s) => s.heartRateBpm !== null).length
    ? targetCourse.segments.reduce((s, seg) => s + (seg.heartRateBpm ?? 0), 0) / targetCourse.segments.filter((s) => s.heartRateBpm !== null).length
    : null;
  console.log(`Target: "${targetName}", ${(targetCourse.totalDistance3D / 1000).toFixed(1)}km, ${targetCourse.totalElevationGain.toFixed(0)}m gain.`);
  console.log(`ACTUAL result: moving time ${formatHms(actualFinishS)}${actualAvgHr !== null ? `, avg HR ~${actualAvgHr.toFixed(0)}bpm (recorded)` : ""}\n`);

  const solverInputs: SolverInputs = { segments: targetCourse.segments, ...commonInputs, ceilingParams: fittedCeilingParams };
  const hrEstimateInputs = hrCalibrationFit ? { calibration: hrCalibrationFit } : undefined;

  function report(label: string, theta: number, result: ReturnType<typeof findSustainableTheta>["result"]) {
    const errS = result.feasible ? result.finishTimeS - actualFinishS : null;
    console.log(`--- ${label} ---`);
    console.log(`  Finish time: ${result.feasible ? formatHms(result.finishTimeS) : "BONKS/INFEASIBLE"} (${(theta * 100).toFixed(0)}% effort)`);
    if (errS !== null) console.log(`  vs actual: ${errS >= 0 ? "+" : ""}${formatHms(errS)} (${((100 * errS) / actualFinishS).toFixed(1)}%)`);
    if (result.feasible) {
      const chartPoints = buildChartPoints(targetCourse.segments, result.segments, hrEstimateInputs);
      const stats = summarizeChartPoints(chartPoints);
      console.log(
        `  Avg pace: ${fmtPace(stats.avgPaceMinPerKm)}   GAP: ${fmtPace(stats.avgGapMinPerKm)}   ` +
          `Avg HR: ${stats.avgHrBpm !== null ? `~${stats.avgHrBpm.toFixed(0)}bpm (${stats.avgHrSource})` : "n/a"}`,
      );
    } else if (result.bonkIndex !== null) {
      const bonkKm = result.segments[result.segments.length - 1]?.cumulativeDistance3D / 1000;
      console.log(`  Bonked at ~${bonkKm?.toFixed(1)}km`);
    }
    console.log();
  }

  const ceilingResult = findSustainableTheta(solverInputs);
  report("Theoretical ceiling", ceilingResult.theta, ceilingResult.result);

  if (marginFit) {
    const curve: PacingMarginCurve = marginFit;
    const chosen = findFlatPacedFinishTime(solverInputs, { marginCurve: (h) => predictMarginTheta(h, curve) });
    report("Chosen pacing (from your race history)", chosen.targetFraction, chosen.result);

    const best = findFlatPacedFinishTime(solverInputs, { marginCurve: (h) => predictBestDemonstratedTheta(h, curve) });
    report("Best demonstrated", best.targetFraction, best.result);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
