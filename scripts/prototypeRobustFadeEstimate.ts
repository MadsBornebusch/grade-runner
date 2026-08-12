// Full "most robust and realistic fade estimate" prototype, combining
// everything this thread converged on after the frozen-tau backtest turned
// out to be an artifact (see verifyTauFreezeArtifact.ts):
//
//   1. Sane tau ceiling -- reject any tau-only fit landing at/above
//      SANE_TAU_CEILING_MIN as untrustworthy (a boundary-adjacent runaway,
//      like the real 3867min case that hit the search's own 3905min cap),
//      rather than trusting the algorithm's own generous 2.5x-longest-race/
//      5000min bound. Implemented as a post-hoc rejection wrapper around the
//      real fitTauAcrossRaces (can't change its internal search bounds
//      without editing pacingFit.ts, which this prototype deliberately
//      doesn't touch yet) -- practically equivalent to bounding the search.
//   2. Tau uncertainty as a BAND, not a point -- bootstrapTauConfidenceInterval
//      already exists and is unmodified here; a second, sane-ceiling-aware
//      bootstrap runs alongside it so the two can be compared directly.
//   3. fInf fit on the expanded (>=120min) pool, evaluated at the tau BAND's
//      low/median/high (not a single frozen tau) -- so fInf's own reported
//      range honestly reflects tau's uncertainty instead of hiding it.
//   4. Leave-one-out backtest on the three long informative races, arbiter
//      = held-out residual fade, compared against the already-known shipped
//      LOO numbers (0.54 / 1.01 / 2.64 %/h).
//
// Usage: npx tsx scripts/prototypeRobustFadeEstimate.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import {
  bootstrapTauConfidenceInterval,
  buildEffortTrendPoints,
  computeFadeTrend,
  fitTauAcrossRaces,
  fitTauFInfWithSupportGate,
  MIN_FIT_POINTS,
  MIN_INFORMATIVE_RACES,
  percentile,
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
const EXPANDED_POOL_MIN_DURATION_MIN = 120;
const BOOTSTRAP_SAMPLES = 100;

/** Prototype parameter, not derived from physiology literature -- a round
 * number a few multiples above the well-supported estimates seen
 * throughout this session (295-445min across different data windows), well
 * below the real runaway case (3867min, which hit the search's own
 * 3905min bound). Open to revision once more long-race data accumulates;
 * the point being tested is whether ANY sane ceiling meaningfully
 * stabilizes the bootstrap, not this exact number. */
const SANE_TAU_CEILING_MIN = 1500;

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);
const MIN_FINF = 0.1;
const FINF_UPPER_MARGIN = 0.02;
const DEFAULT_LT2_FRACTION = 0.85;

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

/** Same fixed-tau, fInf-only search as prototypeFInfFromExpandedPool.ts. */
function fitFInfAtFixedTau(races: Race[], params: CeilingParams, fixedTauMin: number, now: Date, halfLifeDays = 75) {
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
  return Math.round(fine.fInf * 1000) / 1000;
}

/** Sane-ceiling-aware bootstrap: same resampling logic as the shipped
 * bootstrapTauConfidenceInterval, plus one extra rejection criterion
 * (tauMin >= SANE_TAU_CEILING_MIN). Reimplemented rather than parameterizing
 * the shipped function, to keep this a pure prototype -- see file header. */
function boundedBootstrapTau(races: EffortTrendPoint[][], dates: (Date | null)[], params: CeilingParams, saneCeiling: number, samples = BOOTSTRAP_SAMPLES) {
  const point = fitTauFInfWithSupportGate(races, params, { raceDates: dates });
  if (point.tier === "defaults") return null;
  const pointTau = point.ceilingParams.tauMin!;

  const tauSamples: number[] = [];
  let skippedForCeiling = 0;
  let skippedOther = 0;
  for (let i = 0; i < samples; i++) {
    const indices = races.map(() => Math.floor(Math.random() * races.length));
    const resampled = indices.map((idx) => races[idx]);
    const resampledDates = indices.map((idx) => dates[idx]);
    const fit = fitTauAcrossRaces(resampled, point.ceilingParams, { raceDates: resampledDates });
    if (!fit || fit.informativeRaceCount < MIN_INFORMATIVE_RACES || fit.hitSearchBoundary) {
      skippedOther++;
      continue;
    }
    if (fit.tauMin >= saneCeiling) {
      skippedForCeiling++;
      continue;
    }
    tauSamples.push(fit.tauMin);
  }
  tauSamples.sort((a, b) => a - b);
  if (tauSamples.length === 0) return null;
  return {
    pointTau,
    low: percentile(tauSamples, 0.1),
    median: percentile(tauSamples, 0.5),
    high: percentile(tauSamples, 0.9),
    sampleCount: tauSamples.length,
    skippedForCeiling,
    skippedOther,
  };
}

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
  console.log(`${races.length} races total.\n`);
  const now = new Date();

  // ---- Full-pool: unbounded (shipped) vs. sane-ceiling-bounded bootstrap ----
  const rawRaces = races.map((r) => r.points);
  const raceDates = races.map((r) => r.date);

  console.log("=== Full pool: tau bootstrap, shipped (unbounded) vs. sane-ceiling-bounded ===");
  const shippedBand = await bootstrapTauConfidenceInterval(rawRaces, raceDates, ceilingParams);
  console.log(
    shippedBand
      ? `Shipped:  point=${shippedBand.pointEstimateTauMin}  band=[${shippedBand.lowTauMin.toFixed(0)}, ${shippedBand.medianTauMin.toFixed(0)}, ${shippedBand.highTauMin.toFixed(0)}]  n=${shippedBand.sampleCount} (skipped ${shippedBand.skippedCount})`
      : "null",
  );
  const boundedBand = boundedBootstrapTau(rawRaces, raceDates, ceilingParams, SANE_TAU_CEILING_MIN);
  console.log(
    boundedBand
      ? `Bounded:  point=${boundedBand.pointTau}  band=[${boundedBand.low.toFixed(0)}, ${boundedBand.median.toFixed(0)}, ${boundedBand.high.toFixed(0)}]  n=${boundedBand.sampleCount} (skippedCeiling=${boundedBand.skippedForCeiling}, skippedOther=${boundedBand.skippedOther})`
      : "null",
  );

  // ---- fInf at the bounded band's low/median/high tau, on the expanded pool ----
  const expandedPool = races.filter((r) => r.durationMin >= EXPANDED_POOL_MIN_DURATION_MIN);
  console.log(`\n=== fInf on expanded pool (n=${expandedPool.length}) at each tau in the bounded band ===`);
  if (boundedBand) {
    for (const [label, tau] of [["low", boundedBand.low], ["median", boundedBand.median], ["high", boundedBand.high]] as const) {
      const fInf = fitFInfAtFixedTau(expandedPool, ceilingParams, tau, now);
      console.log(`  tau=${label.padEnd(6)}(${tau.toFixed(0)}min): fInf=${fInf}`);
    }
  }

  // ---- Leave-one-out backtest ----
  console.log("\n=== Leave-one-out backtest: bounded-band pipeline vs. shipped ===");
  console.log("(shipped LOO residuals for reference: Soria Moria 0.54%/h, Ås Backyard 1.01%/h, Ecotrail 80 2.64%/h)\n");
  const longRaceNames = ["Soria Moria", "Backyard", "Ecotrail"];
  for (const nameFragment of longRaceNames) {
    const heldOut = races.find((r) => r.name.includes(nameFragment));
    if (!heldOut) continue;
    const foldRaces = races.filter((r) => r.id !== heldOut.id);
    const foldRaw = foldRaces.map((r) => r.points);
    const foldDates = foldRaces.map((r) => r.date);

    const band = boundedBootstrapTau(foldRaw, foldDates, ceilingParams, SANE_TAU_CEILING_MIN);
    if (!band) {
      console.log(`  ${heldOut.name}: bounded band unavailable`);
      continue;
    }
    const foldExpandedPool = expandedPool.filter((r) => r.id !== heldOut.id);
    const fInfAtMedian = fitFInfAtFixedTau(foldExpandedPool, ceilingParams, band.median, now);
    const residual = fInfAtMedian !== null ? residualPctPerHour(heldOut, fInfAtMedian, band.median) : null;
    console.log(
      `  ${heldOut.name.padEnd(28)} band=[${band.low.toFixed(0)}, ${band.median.toFixed(0)}, ${band.high.toFixed(0)}]min  fInf@median=${fInfAtMedian}  residual=${residual?.toFixed(2)}%/h`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
