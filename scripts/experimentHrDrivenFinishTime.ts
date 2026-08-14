// Tests the user's proposal: instead of findSustainableTheta's zero-margin
// max-sustainable-effort search (already shown this session to under-predict
// finish time by ~30% even on real, race-only held-out data -- see PLAN.md
// SS14 stage 6 follow-up, and findFlatPacedFinishTime's own backtest, which
// found an alternative theoretical pacing SHAPE barely moved that bias),
// read the athlete's OWN recorded heart rate during a race, convert it to an
// effort fraction via the existing hrCalibration.ts machinery, and simulate
// forward at THAT measured effort instead of solving for a theoretical one.
// If that closes the ~30% gap, the bias lives in the feasibility-search
// mechanism, not the underlying cost model (Minetti+altitude+fueling) --
// exactly what today's earlier surface-cost work already found for the
// (smaller) surface-specific slice of this same problem.
//
// Three-way, held-out, EARLY-WINDOW-ONLY comparison (not full-race) per
// fold, to sidestep cardiac drift: hrCalibration.ts's own fitting already
// restricts to each race's own early ~65% (EARLY_WINDOW_FRACTION) because
// heart rate is a worse effort proxy late in a long effort (elevated at
// constant true output, not from more true effort) -- inverting a
// calibration against LATE, drift-affected HR would read as "higher effort"
// and bias predicted time the SAME direction as the bug being investigated,
// making the two impossible to tell apart without this restriction.
//
// - actual: the athlete's own recorded time to reach the cutoff segment.
// - theta: findSustainableTheta's FULL-course solve, read off at the same
//   cutoff segment (matches today's production prediction mechanism).
// - hrDriven: simulate() with the new targetGrossPowerWPerKgOverride option
//   (solver.ts), fed effortFraction = predictEffortFractionFromHr(recorded
//   HR, calibration) * ceilingPower(...) per segment, truncated to the
//   cutoff -- deliberately glycogen/bonk is still active (simulate()'s own
//   loop, unchanged), but the early-window restriction should keep this
//   from mattering (bonk is a late-race phenomenon in a several-hour race).
//
// Uses the data-driven fitHrToEffortCalibrationAcrossRaces (leave-one-out
// per fold, same discipline as tau/fInf/surface fits above), NOT the
// cleaner threshold-based fitHrToEffortCalibrationFromThresholds -- this
// athlete's real lt1HeartRateBpm/lt2HeartRateBpm aren't available to an
// offline script (reference-only formInputs fields, not persisted anywhere
// this script can read without a live authenticated session). Flagged
// explicitly in the report: this makes the HR-driven arm somewhat less
// clean (its calibration is trained on pace-derived power, so a perfect
// result would be partly a round-trip through pace) than the fully
// non-circular version a real threshold HR would allow.
//
// No surface-cost multiplier is applied on EITHER the theta or hrDriven arm
// (multiplier=1 throughout) -- deliberately orthogonal to today's earlier
// surface-cost work, so this experiment isolates the effort-source question
// alone.
//
// Usage: npx tsx scripts/experimentHrDrivenFinishTime.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { fitHrToEffortCalibrationAcrossRaces, predictEffortFractionFromHr } from "../src/model/hrCalibration.ts";
import { buildEffortTrendPoints, fitTauFInfWithSupportGate, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { findSustainableTheta, simulate, type SolverInputs } from "../src/model/solver.ts";
import { buildWithinRaceDiagnosticPoint } from "../src/model/withinRaceDescentDiagnostic.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";

const REAL_VO2_MAX = 54;
const REAL_BODY_MASS_KG = 85;
const EARLY_WINDOW_FRACTION = 0.65; // same constant hrCalibration.ts's own fitting uses

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return { id, name: raw.name, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

interface RunRecord {
  id: string;
  name: string;
  date: Date | null;
  segments: CourseSegment[];
  effortTrendPoints: EffortTrendPoint[];
  actualFinishTimeS: number;
  isSustainedEffort: boolean;
}

async function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: REAL_VO2_MAX };
  const commonInputs = {
    bodyMassKg: REAL_BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: REAL_BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  const runs: RunRecord[] = [];
  for (const file of files) {
    const { id, name, points } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!points.some((p) => p.time !== null)) continue;
    const course = runPipeline(points);
    if (!course.hasTimestamps || course.totalDistance3D <= 0) continue;
    const segments = course.segments;
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    const isSustainedEffort =
      buildWithinRaceDiagnosticPoint(id, { ...course, segments }, { ...commonInputs, ceilingParams: baseCeilingParams }) !== null;
    runs.push({
      id,
      name,
      date: points.find((p) => p.time !== null)?.time ?? null,
      segments,
      effortTrendPoints,
      actualFinishTimeS: analysis.totalMovingTimeS,
      isSustainedEffort,
    });
  }
  console.log(`Activities used: ${runs.length}`);

  // Named-race targeting: the sustained-effort GATE (duration-shaped
  // heuristic) let 14 of 17 generic-titled training runs through while
  // excluding several genuine short races entirely (Askerspurten 10km,
  // Sommerafslutning) -- a real activity NAME is a much more direct signal
  // of "this was actually a race" than any duration/fit-quality proxy.
  // Excludes "Evening Intervals" (a structured workout, not a race) and
  // "Langt Og Langsomt" ("long and slow" in Norwegian -- self-labeled easy).
  const RACE_NAMES = new Set([
    "Askerspurten 10 km",
    "Ecotrail 80",
    'Oslo Trail Challenge "55" km',
    "Oslo Trail Challenge 55 km",
    "Saksumdal 17",
    "Sommerafslutning i den Danske Løbeklub 🇩🇰",
    "Soria Moria til Verdens Ende",
    "Ås Backyard ultra",
    "2.5 km loop every hour",
  ]);
  const useNamedRaces = process.argv.includes("--namedRaces");
  const targetIndices = useNamedRaces
    ? runs.map((_, i) => i).filter((i) => RACE_NAMES.has(runs[i].name))
    : runs.map((_, i) => i).filter((i) => runs[i].isSustainedEffort);
  console.log(`${useNamedRaces ? "Named-race" : "Sustained-effort"} targets: ${targetIndices.length}\n`);

  interface FoldResult {
    name: string;
    actualCutoffS: number;
    thetaCutoffS: number | null;
    hrCutoffS: number | null;
  }
  const results: FoldResult[] = [];
  let skippedNoCalibration = 0;
  let skippedHrInfeasible = 0;
  const chosenThetaByFold: { name: string; durationHours: number; meanChosenTheta: number | null; solvedTheta: number }[] = [];

  let foldNum = 0;
  for (const targetIdx of targetIndices) {
    foldNum++;
    const target = runs[targetIdx];
    process.stderr.write(`fold ${foldNum}/${targetIndices.length} (${target.name})... `);
    const trainingRuns = runs.filter((_, i) => i !== targetIdx);
    const races = trainingRuns.map((r) => r.effortTrendPoints);
    const raceDates = trainingRuns.map((r) => r.date);

    const safeFit = fitTauFInfWithSupportGate(races, baseCeilingParams, { raceDates });
    const ceilingParamsFit = safeFit.ceilingParams;

    const calibration = fitHrToEffortCalibrationAcrossRaces(races, ceilingParamsFit, { raceDates });
    if (!calibration) {
      skippedNoCalibration++;
      process.stderr.write("no calibration, skipped\n");
      continue;
    }

    // Cutoff: last segment whose recorded elapsed time is still within the
    // early window fraction of this race's own actual total time.
    const totalHours = target.actualFinishTimeS / 3600;
    const cutoffHours = totalHours * EARLY_WINDOW_FRACTION;
    let cutoffIndex = target.effortTrendPoints.findIndex((p) => p.tHours >= cutoffHours);
    if (cutoffIndex <= 0) cutoffIndex = target.effortTrendPoints.length - 1;
    const actualCutoffS = target.effortTrendPoints[cutoffIndex].tHours * 3600;

    const solverInputs: SolverInputs = { segments: target.segments, ceilingParams: ceilingParamsFit, ...commonInputs };
    const thetaSolve = findSustainableTheta(solverInputs);
    const thetaCutoffS = thetaSolve.result.feasible && thetaSolve.result.segments[cutoffIndex]
      ? thetaSolve.result.segments[cutoffIndex].cumulativeTimeS
      : null;

    const hrBySegmentIndex = new Map<number, number>();
    target.segments.slice(0, cutoffIndex + 1).forEach((seg, i) => {
      const hr = target.effortTrendPoints[i]?.heartRateBpm;
      if (hr !== undefined) hrBySegmentIndex.set(seg.index, hr);
    });

    // Chosen theta: the athlete's own HR-implied effort fraction, duration-
    // weighted mean over the SAME early window the fit trusts -- the number
    // that decides whether "pacing margin" is a flat scalar haircut on the
    // fitted ceiling or something that itself needs a duration-dependent
    // curve. Computed directly from data already in hand, no new model.
    let weightedThetaSum = 0;
    let weightedThetaWeight = 0;
    for (let i = 0; i <= cutoffIndex; i++) {
      const p = target.effortTrendPoints[i];
      if (p.heartRateBpm === undefined) continue;
      const effortFraction = predictEffortFractionFromHr(p.heartRateBpm, calibration);
      weightedThetaSum += effortFraction * p.dtS;
      weightedThetaWeight += p.dtS;
    }
    const meanChosenTheta = weightedThetaWeight > 0 ? weightedThetaSum / weightedThetaWeight : null;
    chosenThetaByFold.push({
      name: target.name,
      durationHours: target.actualFinishTimeS / 3600,
      meanChosenTheta,
      solvedTheta: thetaSolve.theta,
    });

    const hrResult = simulate(1, { ...solverInputs, segments: target.segments.slice(0, cutoffIndex + 1) }, {
      targetGrossPowerWPerKgOverride: (segmentIndex, elapsedMin, elapsedHours, altitudeM) => {
        const hr = hrBySegmentIndex.get(segmentIndex);
        if (hr === undefined) return null;
        const effortFraction = predictEffortFractionFromHr(hr, calibration);
        const ceiling = ceilingPower({ tMin: elapsedMin, altitudeM, elapsedHours }, ceilingParamsFit);
        return effortFraction * ceiling;
      },
    });
    const hrCutoffS = hrResult.feasible ? hrResult.finishTimeS : null;
    if (hrCutoffS === null) skippedHrInfeasible++;

    results.push({ name: target.name, actualCutoffS, thetaCutoffS, hrCutoffS });
    process.stderr.write(
      `actual=${(actualCutoffS / 60).toFixed(0)}min theta=${thetaCutoffS ? (thetaCutoffS / 60).toFixed(0) : "infeasible"}min hr=${hrCutoffS ? (hrCutoffS / 60).toFixed(0) : "infeasible"}min\n`,
    );
  }

  console.log(`\nFolds: ${results.length} (skipped ${skippedNoCalibration} no-calibration, ${skippedHrInfeasible} HR-arm infeasible before cutoff)\n`);

  function summarize(label: string, pairs: { actual: number; predicted: number }[]) {
    if (pairs.length === 0) {
      console.log(`${label}: no feasible folds`);
      return;
    }
    const signedPct = pairs.map((p) => (100 * (p.predicted - p.actual)) / p.actual);
    const absPct = signedPct.map(Math.abs);
    const meanSigned = signedPct.reduce((a, b) => a + b, 0) / signedPct.length;
    const meanAbs = absPct.reduce((a, b) => a + b, 0) / absPct.length;
    const sorted = [...absPct].sort((a, b) => a - b);
    const medianAbs = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `${label.padEnd(12)} n=${String(pairs.length).padStart(2)}  mean|err|=${meanAbs.toFixed(2).padStart(7)}%  median|err|=${medianAbs.toFixed(2).padStart(7)}%  mean signed=${meanSigned >= 0 ? "+" : ""}${meanSigned.toFixed(2)}%`,
    );
  }

  summarize(
    "theta",
    results.filter((r) => r.thetaCutoffS !== null).map((r) => ({ actual: r.actualCutoffS, predicted: r.thetaCutoffS! })),
  );
  summarize(
    "hrDriven",
    results.filter((r) => r.hrCutoffS !== null).map((r) => ({ actual: r.actualCutoffS, predicted: r.hrCutoffS! })),
  );

  console.log("\nChosen theta (HR-implied, early-window mean) vs. race duration -- the model-form question:");
  console.log("name".padEnd(35), "duration(h)".padStart(11), "chosenTheta".padStart(12), "solvedTheta".padStart(12));
  const sortedByDuration = [...chosenThetaByFold].sort((a, b) => a.durationHours - b.durationHours);
  for (const r of sortedByDuration) {
    console.log(
      r.name.slice(0, 34).padEnd(35),
      r.durationHours.toFixed(2).padStart(11),
      (r.meanChosenTheta !== null ? r.meanChosenTheta.toFixed(3) : "n/a").padStart(12),
      r.solvedTheta.toFixed(3).padStart(12),
    );
  }
  const withTheta = chosenThetaByFold.filter((r): r is typeof r & { meanChosenTheta: number } => r.meanChosenTheta !== null);
  if (withTheta.length > 1) {
    const meanDuration = withTheta.reduce((s, r) => s + r.durationHours, 0) / withTheta.length;
    const meanTheta = withTheta.reduce((s, r) => s + r.meanChosenTheta, 0) / withTheta.length;
    let sXY = 0, sXX = 0;
    for (const r of withTheta) {
      sXY += (r.durationHours - meanDuration) * (r.meanChosenTheta - meanTheta);
      sXX += (r.durationHours - meanDuration) ** 2;
    }
    const slope = sXX > 0 ? sXY / sXX : 0;
    console.log(
      `\nMean chosen theta = ${meanTheta.toFixed(3)} (n=${withTheta.length}). Slope of chosenTheta vs durationHours = ${slope.toFixed(4)} per hour -- near zero means a flat scalar margin fits; a real slope means it needs a duration-dependent curve.`,
    );
  }

  console.log("\nPer-fold detail:");
  console.log("name".padEnd(35), "theta err%".padStart(11), "hr err%".padStart(11));
  for (const r of results) {
    const thetaErr = r.thetaCutoffS !== null ? (100 * (r.thetaCutoffS - r.actualCutoffS)) / r.actualCutoffS : null;
    const hrErr = r.hrCutoffS !== null ? (100 * (r.hrCutoffS - r.actualCutoffS)) / r.actualCutoffS : null;
    console.log(
      r.name.slice(0, 34).padEnd(35),
      (thetaErr !== null ? thetaErr.toFixed(1) + "%" : "infeasible").padStart(11),
      (hrErr !== null ? hrErr.toFixed(1) + "%" : "infeasible").padStart(11),
    );
  }
}

main();
