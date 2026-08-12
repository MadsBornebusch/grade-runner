// Prototype for the fade-signal-vs-duration follow-up (see
// investigateFadeSignalVsDuration.ts and the fade-signal.html artifact it
// produced): that check found races under ~2h are pure noise (stdev
// dwarfing the mean) but the 2-4h band already shows a tight, sensibly
// signed pattern -- currently thrown away entirely by
// poolIndicesInformativeAtReference's 250min floor.
//
// Per advisor's identifiability argument: a short race can only measure
// its own initial fade rate ~ (1-fInf)/tau -- ONE equation in TWO unknowns.
// It cannot separate tau from fInf on its own, so "let short/medium races
// into the joint fInf+tau search" is exactly the mechanism that produced
// the tau=21min collapse earlier this session. The safe way to use the
// 2-4h band's signal is to hold tau FIXED at the long-race value and fit
// ONLY fInf against the expanded pool -- that structurally cannot move
// tau, so it cannot re-break the fit the way a joint refit could.
//
// Two arms:
//   A. Gate-check joint refit -- reuses fitFInfAndTauAcrossRaces UNCHANGED,
//      just lowers the reference floor it uses to decide pool membership
//      (poolIndicesInformativeAtReference reads ceilingParams.tauMin as
//      that reference) from 250min to 120min. If tau stays near the
//      long-race value, the expansion is safe; if it drops, the shorter
//      races are swamping and that's the finding, not something to tune
//      around.
//   B. Fixed-tau, fInf-only 1D search over the expanded pool (own code
//      below -- no existing function does this). Backtested via
//      leave-one-out against each of the three long informative races,
//      compared to the shipped joint fit's own leave-one-out prediction.
//
// Usage: npx tsx scripts/prototypeFInfFromExpandedPool.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import {
  buildEffortTrendPoints,
  computeFadeTrend,
  fitFInfAndTauAcrossRaces,
  MIN_FIT_POINTS,
  trimForPacingFit,
  type EffortTrendPoint,
} from "../src/model/pacingFit.ts";
import type { CeilingParams } from "../src/model/ceiling.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;
const EXPANDED_POOL_MIN_DURATION_MIN = 120; // 2h -- where investigateFadeSignalVsDuration.ts found the signal firm up

// Mirrors pacingFit.ts's own private constants (not exported) -- kept in
// sync by hand; this is a research prototype, not shipped code, so a small
// duplication here is preferable to widening pacingFit.ts's public surface
// for a search variant that hasn't earned a place there yet.
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 75;
const MIN_FINF = 0.1;
const FINF_UPPER_MARGIN = 0.02;
const DEFAULT_LT2_FRACTION = 0.85;

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);

interface Race {
  id: string;
  name: string;
  points: EffortTrendPoint[];
  date: Date | null;
  durationMin: number;
}

function daysAgo(date: Date, now: Date): number {
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
}

/** Fixed-tau, fInf-only search: mirrors fitFInfAndTauAcrossRaces's own
 * coarse-then-fine grid over fInf, but with tau held constant instead of
 * searched per candidate fInf -- see this file's header for why. */
function fitFInfAtFixedTau(
  races: Race[],
  params: CeilingParams,
  fixedTauMin: number,
  now: Date,
  halfLifeDays: number = DEFAULT_RECENCY_HALF_LIFE_DAYS,
): { fInf: number; score: number; hitBoundary: "lower" | "upper" | null; n: number } | null {
  if (races.length === 0) return null;
  const weights = races.map((r) => (r.date ? Math.exp((-Math.LN2 * daysAgo(r.date, now)) / halfLifeDays) : 1));
  const lt2Fraction = params.lt2Fraction ?? DEFAULT_LT2_FRACTION;
  const fInfLo = MIN_FINF;
  const fInfHi = Math.max(fInfLo + 0.01, lt2Fraction - FINF_UPPER_MARGIN);

  const pooledSquaredSlope = (fInf: number) => {
    let sum = 0;
    for (let i = 0; i < races.length; i++) {
      const trend = computeFadeTrend(races[i].points, { ...params, fInf, tauMin: fixedTauMin });
      if (!trend) return Infinity;
      sum += weights[i] * trend.slopePerHour ** 2;
    }
    return sum;
  };
  const gridSearch = (lo: number, hi: number, count: number) => {
    let best = { fInf: lo, score: Infinity };
    const step = count > 1 ? (hi - lo) / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      const fInf = lo + i * step;
      const score = pooledSquaredSlope(fInf);
      if (score < best.score) best = { fInf, score };
    }
    return best;
  };
  const coarseStep = Math.max(0.01, (fInfHi - fInfLo) / 25);
  const coarse = gridSearch(fInfLo, fInfHi, 26);
  const fine = gridSearch(Math.max(fInfLo, coarse.fInf - coarseStep), Math.min(fInfHi, coarse.fInf + coarseStep), 11);
  const fInf = Math.round(fine.fInf * 1000) / 1000;
  return {
    fInf,
    score: fine.score,
    hitBoundary: fInf <= fInfLo + 0.005 ? "lower" : fInf >= fInfHi - 0.005 ? "upper" : null,
    n: races.length,
  };
}

/** |predicted residual slope| at a given (fInf, tau) for one held-out
 * race -- the model's own definition of "explains this race well" is a
 * near-zero fade trend at the true params, so smaller is better. */
function residualPctPerHour(race: Race, fInf: number, tauMin: number): number | null {
  const trend = computeFadeTrend(race.points, { ...ceilingParams, fInf, tauMin });
  return trend ? Math.abs(trend.slopePerHour * 100) : null;
}

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    console.log("No .strava-session.local -- proceeding offline (cached data only).\n");
  }

  const runs = await backfill(BASE_URL, cookie, SINCE_DATE).catch(() => backfill(BASE_URL, cookie, SINCE_DATE, { offline: true }));
  const { kept } = dedupeStoredRuns(runs);

  const races: Race[] = [];
  for (const run of kept) {
    if (run.stravaId === undefined) continue;
    let points;
    try {
      ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    } catch {
      continue;
    }
    const pointLegs = splitAtTransitGaps(points);
    for (const legPoints of pointLegs) {
      const course = runPipeline(legPoints);
      if (!course.hasTimestamps) continue;
      if (pointLegs.length > 1 && course.totalDistance3D / 1000 < MIN_LEG_DISTANCE_KM) continue;
      const analysis = analyzeRun(course.segments, {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      });
      const trendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      const trimmed = trimForPacingFit(trendPoints);
      if (trimmed.length < MIN_FIT_POINTS) continue;
      races.push({
        id: run.id + (pointLegs.length > 1 ? `:${pointLegs.indexOf(legPoints)}` : ""),
        name: run.name + (pointLegs.length > 1 ? " (leg)" : ""),
        points: trimmed,
        date: pointLegs.length > 1 ? (legPoints[0]?.time ?? (run.date ? new Date(run.date) : null)) : run.date ? new Date(run.date) : null,
        durationMin: trimmed[trimmed.length - 1].tHours * 60,
      });
    }
  }
  console.log(`${races.length} races with enough trimmed points for a fit.\n`);

  const now = new Date();
  const rawRaces = races.map((r) => r.points);
  const raceDates = races.map((r) => r.date);

  // ---- Baseline: shipped joint fit, current 250min floor ----
  const shipped = fitFInfAndTauAcrossRaces(rawRaces, ceilingParams, { raceDates });
  console.log("=== Baseline: shipped joint fit (250min floor) ===");
  console.log(shipped ? `tau=${shipped.tauMin}min fInf=${shipped.fInf} informative=${shipped.informativeRaceCount}/${shipped.perRace.length} hitBoundary=fInf:${shipped.hitSearchBoundary.fInf ?? "no"},tau:${shipped.hitSearchBoundary.tau ?? "no"}` : "null");
  if (!shipped) return;
  const referenceTau = shipped.tauMin;

  // ---- Arm A: gate-check joint refit with a lowered reference floor ----
  console.log(`\n=== Arm A: joint refit, reference floor lowered to ${EXPANDED_POOL_MIN_DURATION_MIN}min ===`);
  const expandedJoint = fitFInfAndTauAcrossRaces(rawRaces, { ...ceilingParams, tauMin: EXPANDED_POOL_MIN_DURATION_MIN }, { raceDates });
  console.log(expandedJoint ? `tau=${expandedJoint.tauMin}min fInf=${expandedJoint.fInf} informative=${expandedJoint.informativeRaceCount}/${expandedJoint.perRace.length} hitBoundary=fInf:${expandedJoint.hitSearchBoundary.fInf ?? "no"},tau:${expandedJoint.hitSearchBoundary.tau ?? "no"}` : "null");
  console.log(
    expandedJoint && Math.abs(expandedJoint.tauMin - referenceTau) / referenceTau < 0.15
      ? `GATE PASS: tau stayed within 15% of the long-race value (${referenceTau}min) -- expansion looks safe.`
      : `GATE FAIL: tau moved away from the long-race value (${referenceTau}min) -- shorter races are swamping the joint search, as identifiability predicts.`,
  );

  // ---- Arm B: fixed tau, fit fInf only, on the expanded pool ----
  console.log(`\n=== Arm B: tau FIXED at ${referenceTau}min, fInf fit alone on races >=${EXPANDED_POOL_MIN_DURATION_MIN}min ===`);
  const expandedPool = races.filter((r) => r.durationMin >= EXPANDED_POOL_MIN_DURATION_MIN);
  const narrowPool = races.filter((r) => r.durationMin >= 250);
  const armBExpanded = fitFInfAtFixedTau(expandedPool, ceilingParams, referenceTau, now);
  const armBNarrow = fitFInfAtFixedTau(narrowPool, ceilingParams, referenceTau, now);
  console.log(`Expanded pool (n=${expandedPool.length}): fInf=${armBExpanded?.fInf} hitBoundary=${armBExpanded?.hitBoundary ?? "no"}`);
  console.log(`Narrow pool, same tau, for comparison (n=${narrowPool.length}): fInf=${armBNarrow?.fInf} hitBoundary=${armBNarrow?.hitBoundary ?? "no"}`);
  console.log(`Shipped fInf for reference: ${shipped.fInf}`);

  // ---- Backtest: leave-one-out on each long informative race ----
  console.log("\n=== Leave-one-out backtest on the long informative races ===");
  const longRaceNames = ["Soria Moria", "Backyard", "Ecotrail"];
  for (const nameFragment of longRaceNames) {
    const heldOut = races.find((r) => r.name.includes(nameFragment));
    if (!heldOut) {
      console.log(`  (no race matching "${nameFragment}" found)`);
      continue;
    }
    const shippedLooRaces = rawRaces.filter((_, i) => races[i].id !== heldOut.id);
    const shippedLooDates = raceDates.filter((_, i) => races[i].id !== heldOut.id);
    const shippedLoo = fitFInfAndTauAcrossRaces(shippedLooRaces, ceilingParams, { raceDates: shippedLooDates });
    const shippedResidual = shippedLoo ? residualPctPerHour(heldOut, shippedLoo.fInf, shippedLoo.tauMin) : null;

    const expandedLooPool = expandedPool.filter((r) => r.id !== heldOut.id);
    const expandedLoo = fitFInfAtFixedTau(expandedLooPool, ceilingParams, referenceTau, now);
    const expandedResidual = expandedLoo ? residualPctPerHour(heldOut, expandedLoo.fInf, referenceTau) : null;

    console.log(
      `  ${heldOut.name.padEnd(28)} shipped: tau=${shippedLoo?.tauMin} fInf=${shippedLoo?.fInf} residual=${shippedResidual?.toFixed(2)}%/h` +
        `  |  expanded: fInf=${expandedLoo?.fInf} (n=${expandedLoo?.n}) residual=${expandedResidual?.toFixed(2)}%/h`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
