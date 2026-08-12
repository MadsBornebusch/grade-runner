// Research question (not an app-functionality test): does a race's OWN
// observed fade rate (computeFadeTrend's slopePerHour, the exact quantity
// pacingFit.ts already reports as trendAtCurrentPctPerHour) carry usable
// signal even for races well short of the ~250min reference-tau floor that
// poolIndicesInformativeAtReference currently uses to decide which races
// enter the pooled tau/fInf objective at all (see that function's own doc
// in pacingFit.ts -- it's a real pre-filter on the fit's objective sum, not
// just a post-hoc reporting flag, confirmed by reading the fit functions
// directly: `poolIndices = poolIndicesInformativeAtReference(...)` feeds
// the pooled sum in both fitTauAcrossRaces and fitFInfAndTauAcrossRaces).
//
// If short/medium races sit tightly on a sensible curve (roughly constant
// near the model's initial fade rate -(1-fInf)/tau for races much shorter
// than tau, bending toward zero as duration approaches/exceeds tau), they
// carry real information -- at minimum for fInf, per the identifiability
// limit a short race can only ever measure the COMBINED initial rate, not
// separate tau from fInf. If they scatter with no visible pattern, noise
// dominates and the current duration floor is doing real work, not just
// being conservative.
//
// No DURABILITY_MIN_DURATION_S filter here (unlike runFit()/suggestRuns.ts)
// -- the whole point is to look at what's currently being excluded.
//
// Usage: npx tsx scripts/investigateFadeSignalVsDuration.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import {
  buildEffortTrendPoints,
  computeEffortTrend,
  computeFadeTrend,
  DEFAULT_TAU_MIN_REFERENCE,
  MIN_INFORMATIVE_RACES,
} from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;
const MIN_RACE_DURATION_MIN = 10; // floor purely to skip GPS noise/junk, not a modeling choice

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);
const referenceTauMin = ceilingParams.tauMin ?? DEFAULT_TAU_MIN_REFERENCE;
const referenceFInf = ceilingParams.fInf ?? 0;
// Idealized initial fade rate for a race much shorter than tau, at the
// currently-configured defaults: -(1-fInf)/tau, in fraction/hour -- purely
// a reference line for the plot, not used in any computation below.
const idealizedInitialRatePctPerHour = (-(1 - referenceFInf) / referenceTauMin) * 60 * 100;

interface Row {
  name: string;
  date: string | null;
  durationH: number;
  fadeRatePctPerHour: number | null;
  method: "binned" | "raw" | "none";
  clearsCurrentPoolFilter: boolean;
}

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    console.log("No .strava-session.local -- proceeding offline (cached data only).\n");
  }

  console.log(`Backfilling since ${SINCE_DATE.toISOString().slice(0, 10)}...`);
  const runs = await backfill(BASE_URL, cookie, SINCE_DATE).catch(() => backfill(BASE_URL, cookie, SINCE_DATE, { offline: true }));
  const { kept } = dedupeStoredRuns(runs);
  console.log(`${kept.length} deduped run summaries.\n`);

  const rows: Row[] = [];
  let fetched = 0;
  let noGps = 0;
  for (const run of kept) {
    if (run.stravaId === undefined) continue;
    let points;
    try {
      ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    } catch {
      noGps++;
      continue;
    }
    fetched++;
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
      const durationMin = analysis.totalMovingTimeS / 60;
      if (durationMin < MIN_RACE_DURATION_MIN) continue;
      const trendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      if (trendPoints.length === 0) continue;

      const binned = computeFadeTrend(trendPoints, ceilingParams);
      const raw = computeEffortTrend(trendPoints, ceilingParams);
      const method: Row["method"] = binned ? "binned" : raw ? "raw" : "none";
      const fadeRatePctPerHour = (binned ?? raw)?.slopePerHour !== undefined ? (binned ?? raw)!.slopePerHour * 100 : null;

      rows.push({
        name: run.name + (pointLegs.length > 1 ? " (leg)" : ""),
        date: run.date ?? null,
        durationH: durationMin / 60,
        fadeRatePctPerHour,
        method,
        clearsCurrentPoolFilter: durationMin >= referenceTauMin,
      });
    }
  }

  console.log(`Fetched ${fetched} runs (${noGps} no GPS/failed). ${rows.length} race legs analyzed.\n`);
  console.log(`Current reference tau=${referenceTauMin}min, fInf=${referenceFInf} -- pool filter requires duration >= ${referenceTauMin}min.`);
  console.log(`Idealized initial fade rate at these defaults: ${idealizedInitialRatePctPerHour.toFixed(2)}%/hour\n`);

  // Bucket by duration for a quick numeric summary before the full dump.
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: "10-30min", lo: 10 / 60, hi: 0.5 },
    { label: "30-60min", lo: 0.5, hi: 1 },
    { label: "1-2h", lo: 1, hi: 2 },
    { label: "2-4h", lo: 2, hi: 4 },
    { label: "4-8h", lo: 4, hi: 8 },
    { label: "8h+", lo: 8, hi: Infinity },
  ];
  console.log("Bucket        n   mean%/h   stdev%/h   clearsPoolFilter");
  for (const b of buckets) {
    const inBucket = rows.filter((r) => r.durationH >= b.lo && r.durationH < b.hi && r.fadeRatePctPerHour !== null);
    if (inBucket.length === 0) {
      console.log(`${b.label.padEnd(12)} 0`);
      continue;
    }
    const vals = inBucket.map((r) => r.fadeRatePctPerHour!);
    const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
    const variance = vals.reduce((a, c) => a + (c - mean) ** 2, 0) / vals.length;
    const clears = inBucket.filter((r) => r.clearsCurrentPoolFilter).length;
    console.log(`${b.label.padEnd(12)} ${String(inBucket.length).padEnd(4)} ${mean.toFixed(2).padStart(7)}   ${Math.sqrt(variance).toFixed(2).padStart(7)}    ${clears}/${inBucket.length}`);
  }

  console.log(`\nMIN_INFORMATIVE_RACES=${MIN_INFORMATIVE_RACES}, races clearing current pool filter (>=${referenceTauMin}min): ${rows.filter((r) => r.clearsCurrentPoolFilter).length}\n`);

  const outPath = fileURLToPath(new URL("../.strava-cache/fadeSignalRows.json", import.meta.url));
  await import("node:fs").then((fs) => fs.writeFileSync(outPath, JSON.stringify(rows, null, 2)));
  console.log(`Full per-race data written to ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
