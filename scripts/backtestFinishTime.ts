// Out-of-sample backtest (PLAN.md §12/§13 stage 5): fit an athlete profile
// on a training window of past races, held out from ONE target race, then
// predict that target race's finish time via the real solver
// (findSustainableTheta) and compare to what actually happened. This is
// the first genuinely predictive check in this project -- everything
// before it (tau/fInf fits, the within-race diagnostic) validated the
// model's retrospective FIT, not its ability to predict a race it never
// saw. It's also the natural way to let real data decide which of the
// three descent-exposure candidates (if any) is worth keeping, rather than
// picking one by in-sample correlation size.
//
// IMPORTANT interpretive note: a good in-sample descent-drift fit (see
// pacingFit.ts's fitDurabilityDriftPerDescentUnitAcrossRaces) is close to
// guaranteed by construction -- within one race, cumulative descent
// exposure is nearly monotonic in elapsed time, so it's easily confounded
// with tau/time-drift already explaining the same downward trend. The
// comparison that actually means something is THIS script's: does adding
// the term improve the predicted finish time for a race the fit never saw.
//
// Same manual/ad hoc nature as testRealStravaFit.ts -- needs a running
// `vercel dev` server and a real, authenticated session (see that script's
// header comment for the one-time cookie setup); not part of the
// automated test suite.
//
// Usage:
//   npx tsx scripts/backtestFinishTime.ts --target="Soria Moria" --since=2025-01-01 --until=2026-01-01
//   npx tsx scripts/backtestFinishTime.ts --target="Soria Moria" --since=2025-01-01 --until=2026-01-01 --exclude="Backyard,Race Simulation"

import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import {
  buildEffortTrendPoints,
  fitDurabilityDriftPerDescentUnitAcrossRaces,
  fitFInfAndTauAcrossRaces,
  fitTauAcrossRaces,
  MIN_INFORMATIVE_RACES,
  type DescentExposureBasis,
  type EffortTrendPoint,
} from "../src/model/pacingFit.ts";
import { findSustainableTheta, type SolverInputs } from "../src/model/solver.ts";
import { suggestRunsForFit } from "../src/model/suggestRuns.ts";
import { DEFAULT_FORM_INPUTS, resolveVo2Max } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const TARGET = arg("target", "");
const SINCE_DATE = new Date(arg("since", "2015-01-01"));
const UNTIL_DATE = new Date(arg("until", new Date().toISOString().slice(0, 10)));
/** Comma-separated name substrings (case-insensitive) to drop from the
 * training set entirely -- e.g. a backyard ultra's looped, forced-pace
 * structure may not represent continuous-effort ultra pacing well, and
 * pooling it in alongside it can visibly skew the fInf/tau fit. Distinct
 * from --target: this drops runs from TRAINING, not from being predicted. */
const EXCLUDE_TERMS = arg("exclude", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const SUGGESTION_COUNT = 10;
/** PLAN.md §11's "~2x+ duration range" precondition for a jointly-fit fInf
 * to mean anything more than an unconstrained absorbing parameter. Below
 * this, fall back to a tau-only fit and hold fInf at its current default. */
const MIN_DURATION_DIVERSITY_RATIO = 2;
const DESCENT_BASES: DescentExposureBasis[] = ["descentMeters", "descentImpact", "descentImpactSquared"];

function formatHms(totalSeconds: number): string {
  const s = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${totalSeconds < 0 ? "-" : ""}${h}h${m.toString().padStart(2, "0")}m${sec.toString().padStart(2, "0")}s`;
}

interface Candidate {
  name: string;
  ceilingParams: CeilingParams;
  descentExposureBasis?: DescentExposureBasis;
}

async function main() {
  if (!TARGET) {
    throw new Error(
      'Missing --target="<race name substring>". Usage: npx tsx scripts/backtestFinishTime.ts ' +
        '--target="Soria Moria" --since=2025-01-01 --until=2026-01-01',
    );
  }

  const cookie = loadCookie(SESSION_FILE, BASE_URL);
  const formInputs = DEFAULT_FORM_INPUTS;
  // Same shape RunLibraryPanel.tsx/testRealStravaFit.ts build -- default
  // athlete params, not any saved profile (this script has no access to
  // localStorage). tauMin/fInf below are starting points only -- both get
  // overwritten by the training-set fit before the target race is predicted.
  const ceilingParams: CeilingParams = {
    vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory),
    lt2Fraction: formInputs.lt2Fraction,
    f0: formInputs.f0,
    fInf: formInputs.fInf,
    tauMin: formInputs.tauMin,
    durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
  };
  const commonInputs = {
    bodyMassKg: formInputs.bodyMassKg,
    fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
    glycogenStoreG: formInputs.glycogenStoreG,
    reserveG: formInputs.reserveG,
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  console.log(`Backfilling run summaries since ${SINCE_DATE.toISOString().slice(0, 10)} from ${BASE_URL}...`);
  const allRuns = await backfill(BASE_URL, cookie, SINCE_DATE);
  console.log(`Found ${allRuns.length} runs.\n`);

  // Prefer the first match ON OR AFTER --until (the "next" occurrence of
  // this race after the training window closes) -- that's what "held out"
  // is supposed to mean. Falls back to the most recent match of any date
  // if nothing qualifies, with a loud warning, since that fallback may sit
  // inside the training window (it's still excluded from training below
  // regardless of why it was picked).
  const targetMatches = allRuns
    .filter((r) => r.name.toLowerCase().includes(TARGET.toLowerCase()))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const targetRun = targetMatches.find((r) => r.date && new Date(r.date) >= UNTIL_DATE) ?? targetMatches[targetMatches.length - 1];
  if (!targetRun) {
    throw new Error(`No run found matching --target="${TARGET}" since ${SINCE_DATE.toISOString().slice(0, 10)}.`);
  }
  if (!targetRun.date || new Date(targetRun.date) < UNTIL_DATE) {
    console.log(
      `  WARNING: no match for "${TARGET}" on/after --until=${UNTIL_DATE.toISOString().slice(0, 10)} -- falling back to ` +
        `the most recent match (${targetRun.name}, ${targetRun.date ?? "unknown date"}), which may fall inside the ` +
        `training window. It is excluded from training below regardless.`,
    );
  }
  console.log(`Target race: ${targetRun.name} (${targetRun.date ?? "unknown date"})\n`);

  const trainingRuns = allRuns.filter(
    (r) =>
      r.id !== targetRun.id &&
      r.date &&
      new Date(r.date) >= SINCE_DATE &&
      new Date(r.date) < UNTIL_DATE &&
      !EXCLUDE_TERMS.some((term) => r.name.toLowerCase().includes(term)),
  );
  console.log(
    `Training window [${SINCE_DATE.toISOString().slice(0, 10)}, ${UNTIL_DATE.toISOString().slice(0, 10)}): ` +
      `${trainingRuns.length} candidate runs (target excluded${EXCLUDE_TERMS.length ? `, plus names matching [${EXCLUDE_TERMS.join(", ")}] excluded` : ""}).`,
  );

  const suggestions = suggestRunsForFit(trainingRuns, SUGGESTION_COUNT);
  const byId = new Map(
    [...suggestions.vo2max, ...suggestions.durability, ...suggestions.durationSpread].map((r) => [r.id, r]),
  );
  const candidateRuns = [...byId.values()];
  console.log(`Fetching full GPS data for ${candidateRuns.length} training candidates (deduped across buckets)...\n`);

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
  for (const run of candidateRuns) {
    if (run.stravaId === undefined) continue;
    let points;
    try {
      ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    } catch (err) {
      console.log(`  skipped (fetch failed: ${err instanceof Error ? err.message : err}): ${run.name}`);
      continue;
    }
    const course = runPipeline(points);
    if (!course.hasTimestamps) {
      console.log(`  skipped (no timestamps): ${run.name}`);
      continue;
    }
    const analysis = analyzeRun(course.segments, { ...commonInputs, ceilingParams });
    races.push(buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment));
    raceDates.push(run.date ? new Date(run.date) : null);
    console.log(`  fetched: ${run.name} (${(course.totalDistance3D / 1000).toFixed(1)}km)`);
  }

  if (races.length === 0) {
    throw new Error("No training races with usable timestamps -- can't fit anything.");
  }
  console.log(`\n${races.length} training races with usable timestamps -- fitting...\n`);

  // Three-tier fallback: joint fInf/tau fit -> tau-only fit -> hold the
  // current defaults untouched. Each tier requires at least
  // MIN_INFORMATIVE_RACES races that actually constrain the parameter(s)
  // being fit (see pacingFit.ts's own doc on informativeRaceCount) -- a fit
  // "pooled across N races" where only one of them is actually informative
  // is really just that one race's idiosyncratic pacing, not a genuine
  // consensus, and shouldn't be trusted just because it ran without error.
  const fInfFit = fitFInfAndTauAcrossRaces(races, ceilingParams, { raceDates });
  const tauFit = fitTauAcrossRaces(races, ceilingParams, { raceDates });
  let fittedCeilingParams: CeilingParams = ceilingParams;
  if (
    fInfFit &&
    fInfFit.durationDiversityRatio >= MIN_DURATION_DIVERSITY_RATIO &&
    fInfFit.informativeRaceCount >= MIN_INFORMATIVE_RACES &&
    !fInfFit.hitSearchBoundary.fInf &&
    !fInfFit.hitSearchBoundary.tau
  ) {
    fittedCeilingParams = { ...ceilingParams, fInf: fInfFit.fInf, tauMin: fInfFit.tauMin };
    console.log(
      `Using jointly-fit fInf=${fInfFit.fInf}, tauMin=${fInfFit.tauMin}min ` +
        `(durationDiversityRatio=${fInfFit.durationDiversityRatio.toFixed(1)}, ` +
        `informativeRaceCount=${fInfFit.informativeRaceCount}/${fInfFit.perRace.length}).`,
    );
  } else if (tauFit && tauFit.informativeRaceCount >= MIN_INFORMATIVE_RACES && !tauFit.hitSearchBoundary) {
    fittedCeilingParams = { ...ceilingParams, tauMin: tauFit.tauMin };
    console.log(
      `fInf/tau joint fit unreliable (durationDiversityRatio=${fInfFit?.durationDiversityRatio.toFixed(1) ?? "n/a"}, ` +
        `informativeRaceCount=${fInfFit?.informativeRaceCount ?? 0}/${fInfFit?.perRace.length ?? 0}, ` +
        `hitSearchBoundary=${JSON.stringify(fInfFit?.hitSearchBoundary ?? null)}) -- falling back to a tau-only fit: ` +
        `tauMin=${tauFit.tauMin}min (informativeRaceCount=${tauFit.informativeRaceCount}/${tauFit.perRace.length}), ` +
        `fInf held at the default ${ceilingParams.fInf}.`,
    );
  } else {
    console.log(
      `  WARNING: neither the joint fInf/tau fit nor the tau-only fit had at least ${MIN_INFORMATIVE_RACES} ` +
        `informative races (tau-only informativeRaceCount=${tauFit?.informativeRaceCount ?? 0}/${tauFit?.perRace.length ?? 0}) -- ` +
        `holding tau=${ceilingParams.tauMin}min/fInf=${ceilingParams.fInf} at their current defaults rather than trusting ` +
        `a fit that a single race could have driven on its own.`,
    );
  }

  console.log("\nFitting descent-based durability drift per candidate basis (training set, fInf/tau held fixed):");
  const candidates: Candidate[] = [{ name: "baseline (no descent term)", ceilingParams: fittedCeilingParams }];
  for (const basis of DESCENT_BASES) {
    const driftFit = fitDurabilityDriftPerDescentUnitAcrossRaces(races, basis, fittedCeilingParams, { raceDates });
    if (!driftFit) {
      console.log(`  ${basis}: no usable fit on the training set (no descent exposure recorded, or too few points) -- skipped.`);
      continue;
    }
    if (driftFit.informativeRaceCount < MIN_INFORMATIVE_RACES) {
      console.log(
        `  ${basis}: skipped -- only ${driftFit.informativeRaceCount}/${driftFit.perRace.length} training races actually ` +
          `constrained this rate (need >= ${MIN_INFORMATIVE_RACES}); trusting it would mean trusting essentially one race's ` +
          `descent pattern, not a genuine cross-race fit.`,
      );
      continue;
    }
    console.log(
      `  ${basis}: durabilityDriftPerDescentUnit=${driftFit.durabilityDriftPerDescentUnit.toExponential(3)} ` +
        `(informativeRaceCount=${driftFit.informativeRaceCount}/${driftFit.perRace.length})`,
    );
    candidates.push({
      name: basis,
      ceilingParams: { ...fittedCeilingParams, durabilityDriftPerDescentUnit: driftFit.durabilityDriftPerDescentUnit },
      descentExposureBasis: basis,
    });
  }

  console.log(`\nFetching target race data: ${targetRun.name}...`);
  if (targetRun.stravaId === undefined) throw new Error(`Target run "${targetRun.name}" has no Strava ID.`);
  const { points: targetPoints } = await fetchActivityPoints(BASE_URL, cookie, targetRun.stravaId);
  const targetCourse = runPipeline(targetPoints);
  if (!targetCourse.hasTimestamps) {
    throw new Error(`Target run "${targetRun.name}" has no timestamps -- can't read its actual finish time.`);
  }
  // Purely mechanical (segment dt sums, no model params involved) -- the
  // real recorded moving time, independent of which candidate is scored
  // against it. Matches what the solver's own finishTimeS represents (pure
  // moving time, no pauses).
  const targetAnalysis = analyzeRun(targetCourse.segments, { ...commonInputs, ceilingParams: fittedCeilingParams });
  const actualFinishTimeS = targetAnalysis.totalMovingTimeS;
  console.log(`Actual recorded moving time: ${formatHms(actualFinishTimeS)}\n`);

  console.log("Candidate predictions vs. actual (findSustainableTheta on the target race's own course):");
  for (const candidate of candidates) {
    const solverInputs: SolverInputs = {
      segments: targetCourse.segments,
      ...commonInputs,
      ceilingParams: candidate.ceilingParams,
      descentExposureBasis: candidate.descentExposureBasis,
    };
    const { result } = findSustainableTheta(solverInputs);
    const predicted = result.finishTimeS;
    const errorS = predicted - actualFinishTimeS;
    const errorPct = (100 * errorS) / actualFinishTimeS;
    console.log(
      `  ${candidate.name.padEnd(24)} predicted ${formatHms(predicted).padEnd(11)} actual ${formatHms(actualFinishTimeS).padEnd(11)} ` +
        `error ${errorS >= 0 ? "+" : ""}${formatHms(errorS)} (${errorPct >= 0 ? "+" : ""}${errorPct.toFixed(1)}%)` +
        `${result.feasible ? "" : "  ** NOT FEASIBLE (bonked/stalled before finishing) **"}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
