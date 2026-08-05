// Follow-up to reproduceLiveTauFInfFit.ts: that script showed the current
// production pipeline (suggestRunsForFit, 60/bucket, interleave, cap 60)
// lands on a well-supported joint fit (tau=445min, fInf=0.678, no boundary
// hit) against real data since 2025-01-01 -- but the informative-race count
// behind it was only 2 of 30. A pooled fit "supported" by just 2 races is
// only as solid as those 2 races are representative, so this script asks:
// how much does the RESULT move if run selection had gone even slightly
// differently?
//
// Three angles:
//   1. Full-pool fit -- fetch and fit EVERY available run since the cutoff
//      (not just the 60-candidate subset), to see the ceiling of what the
//      athlete's own data can support, and list exactly which races count
//      as "informative" (see pacingFit.ts's own doc on why only these
//      actually constrain the fit).
//   2. Leave-one-out on the full pool's informative races -- remove each
//      one at a time and refit; a result that swings wildly when a SINGLE
//      race is removed means the fit's support is fragile, not solid.
//   3. Cap sweep -- rerun the actual production selection algorithm
//      (suggestRunsForFit + interleave + slice) at several total-cap
//      values, to see whether 60 is already enough or whether the result
//      keeps changing as more candidates are let in.
//
// Usage: npx tsx scripts/investigateRunSelectionSensitivity.ts [--since=2025-01-01] [--base=http://localhost:3000]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { buildEffortTrendPoints, fitFInfAndTauAcrossRaces, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { DURABILITY_MIN_DURATION_S, suggestRunsForFit } from "../src/model/suggestRuns.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import type { StoredRun } from "../src/storage/runLibrary.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2025-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const FETCH_DELAY_MS = 150;

const MIN_LEG_DISTANCE_KM = 5;

function interleave<T>(lists: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) result.push(list[i]);
    }
  }
  return result;
}

function runDate(run: StoredRun): Date | null {
  return run.date ? new Date(run.date) : null;
}

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);

interface Race {
  id: string;
  label: string;
  points: EffortTrendPoint[];
  date: Date | null;
  durationH: number;
}

/** Fetches (cache-first) + transit-splits + duration-filters one run into
 * zero or more Race entries -- mirrors runFit()'s own per-run loop exactly
 * (minus surface data, which is a documented no-op for this particular
 * analyzeRun call -- see reproduceLiveTauFInfFit.ts's header comment). */
async function buildRacesForRun(cookie: string, run: StoredRun, sleepBetween: boolean): Promise<Race[]> {
  if (run.stravaId === undefined) return [];
  let points;
  try {
    ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    if (sleepBetween) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  } catch {
    return [];
  }
  const pointLegs = splitAtTransitGaps(points);
  const out: Race[] = [];
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
    if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) continue;
    const trendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
    out.push({
      id: run.id + (pointLegs.length > 1 ? `:${pointLegs.indexOf(legPoints)}` : ""),
      label: run.name + (pointLegs.length > 1 ? " (leg)" : ""),
      points: trendPoints,
      date: pointLegs.length > 1 ? (legPoints[0]?.time ?? runDate(run)) : runDate(run),
      durationH: analysis.totalMovingTimeS / 3600,
    });
  }
  return out;
}

function fitAndReport(label: string, races: Race[]) {
  const trendLists = races.map((r) => r.points);
  const dates = races.map((r) => r.date);
  const fit = fitFInfAndTauAcrossRaces(trendLists, ceilingParams, { raceDates: dates });
  if (!fit) {
    console.log(`${label}: n=${races.length} -- joint fit returned null`);
    return null;
  }
  console.log(
    `${label}: n=${races.length} tau=${fit.tauMin}min fInf=${fit.fInf} ` +
      `diversityRatio=${fit.durationDiversityRatio.toFixed(2)} informative=${fit.informativeRaceCount}/${fit.perRace.length} ` +
      `hitBoundary=fInf:${fit.hitSearchBoundary.fInf ?? "no"},tau:${fit.hitSearchBoundary.tau ?? "no"}`,
  );
  return fit;
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

  // ---- 1. Full-pool fit: fetch + build races for EVERY summary, not just
  // the 60-candidate subset the production auto-fetch would pick. ----
  console.log("=== Fetching full pool (every run since cutoff) ===");
  const allRaces: Race[] = [];
  let fetched = 0;
  let noGps = 0;
  for (const run of kept) {
    if (run.stravaId === undefined) continue;
    const races = await buildRacesForRun(cookie, run, true);
    if (races.length === 0) {
      noGps++;
      continue;
    }
    fetched++;
    allRaces.push(...races);
  }
  console.log(`Fetched ${fetched} runs with usable GPS data (${noGps} had none/failed).`);
  console.log(`${allRaces.length} races after transit-split + duration filter.\n`);

  const fullFit = fitAndReport("FULL POOL joint fit", allRaces);
  if (!fullFit) return;

  console.log("\nInformative races in the full pool (these are the ones actually constraining tau/fInf):");
  const informativeRaces = allRaces.filter((_, i) => !fullFit.perRace[i].unresponsive);
  for (const r of informativeRaces) {
    console.log(`  ${r.label.padEnd(30)} ${r.date?.toISOString().slice(0, 10) ?? "?"}  ${r.durationH.toFixed(2)}h`);
  }
  console.log(`(${informativeRaces.length} of ${allRaces.length} total)\n`);

  // ---- 2. Leave-one-out on the full pool's informative races ----
  console.log("=== Leave-one-out: remove each informative race, refit on the rest ===");
  for (const victim of informativeRaces) {
    const remaining = allRaces.filter((r) => r.id !== victim.id);
    fitAndReport(`  without "${victim.label}" (${victim.durationH.toFixed(1)}h)`, remaining);
  }

  // ---- 3. Cap sweep using the real production selection algorithm ----
  console.log("\n=== Cap sweep (real suggestRunsForFit + interleave selection) ===");
  for (const cap of [20, 40, 60, 90, 120, kept.length]) {
    const suggestions = suggestRunsForFit(kept, cap);
    const interleaved = interleave([suggestions.vo2max, suggestions.durability, suggestions.durationSpread]);
    const byId = new Map<string, StoredRun>();
    for (const r of interleaved) if (!byId.has(r.id)) byId.set(r.id, r);
    const candidates = [...byId.values()].slice(0, cap);
    const races: Race[] = [];
    for (const run of candidates) {
      races.push(...(await buildRacesForRun(cookie, run, false)));
    }
    fitAndReport(`cap=${cap} (${candidates.length} candidates)`, races);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
