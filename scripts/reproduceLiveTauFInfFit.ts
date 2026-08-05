// Reproduces exactly what the app's own "auto-fetch + Fit" pipeline in
// RunLibraryPanel.tsx would produce against real Strava data, from a script
// -- so a surprising live result (e.g. "joint fit lands on tau=21min") can
// be checked against the app's OWN candidate selection and safeguard logic
// without needing to click through the UI. Mirrors, in order:
//   1. backfill() -- same as runBackfill()
//   2. dedupeStoredRuns -- same as dedupedRuns
//   3. suggestRunsForFit(kept, 60) + interleave + slice(0, 60) -- same as
//      markNewFetchCandidates's candidate selection
//   4. fetchActivityPoints (disk-cached) -- same as ensurePointsForRun
//   5. splitAtTransitGaps + MIN_LEG_DISTANCE_KM + DURABILITY_MIN_DURATION_S
//      filter + analyzeRun (no surface data -- see note below) -- same as
//      runFit()'s own per-run loop
//   6. fitTauFInfWithSupportGate -- same safeguard the app applies
//
// Surface data is deliberately NOT fetched/attached here: runFit()'s own
// analyzeRun call for building EffortTrendPoints passes neither
// unpavedCostMultiplier nor surfaceCostMultipliers, so a segment's
// surfaceUnpaved flag is a no-op for this particular analysis (terrainMultiplier
// falls back to 1 either way -- see analysis.ts line ~144). Surface only
// matters for the separate unpavedCostMultiplier fit, which isn't what's
// being checked here.
//
// Usage: npx tsx scripts/reproduceLiveTauFInfFit.ts [--since=2025-01-01] [--base=http://localhost:3000]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { buildEffortTrendPoints, fitTauFInfWithSupportGate, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { DURABILITY_MIN_DURATION_S, suggestRunsForFit } from "../src/model/suggestRuns.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import type { StoredRun } from "../src/storage/runLibrary.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2025-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));

const AUTO_FETCH_CANDIDATE_COUNT = 60;
const AUTO_FETCH_TOTAL_CAP = 60;
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
  if (run.date) return new Date(run.date);
  return null;
}

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    console.log("No .strava-session.local found -- proceeding offline (cached data only).\n");
  }

  console.log(`Backfilling run summaries since ${SINCE_DATE.toISOString().slice(0, 10)}...`);
  let runs: StoredRun[];
  try {
    runs = await backfill(BASE_URL, cookie, SINCE_DATE);
  } catch {
    runs = await backfill(BASE_URL, cookie, SINCE_DATE, { offline: true });
  }
  console.log(`Found ${runs.length} run summaries since then.\n`);

  const { kept } = dedupeStoredRuns(runs);
  const suggestions = suggestRunsForFit(kept, AUTO_FETCH_CANDIDATE_COUNT);
  console.log(
    `Suggested (per-bucket, cap ${AUTO_FETCH_CANDIDATE_COUNT}) -- vo2max: ${suggestions.vo2max.length}, ` +
      `durability: ${suggestions.durability.length}, durationSpread: ${suggestions.durationSpread.length}`,
  );
  const interleaved = interleave([suggestions.vo2max, suggestions.durability, suggestions.durationSpread]);
  const byId = new Map<string, StoredRun>();
  for (const r of interleaved) if (!byId.has(r.id)) byId.set(r.id, r);
  const candidates = [...byId.values()].slice(0, AUTO_FETCH_TOTAL_CAP);
  console.log(`Candidates after interleave+cap (${AUTO_FETCH_TOTAL_CAP}): ${candidates.length}\n`);

  const formInputs = DEFAULT_FORM_INPUTS;
  const ceilingParams = resolveCeilingParams(formInputs);

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
  const raceLabels: string[] = [];
  let detectedTransitGaps = 0;
  let excludedForDuration = 0;
  let fetchFailures = 0;

  for (const run of candidates) {
    if (run.stravaId === undefined) continue;
    let points;
    try {
      ({ points } = await fetchActivityPoints(BASE_URL, cookie, run.stravaId));
    } catch (err) {
      fetchFailures++;
      console.log(`  skipped (fetch failed: ${err instanceof Error ? err.message : err}): ${run.name}`);
      continue;
    }
    const pointLegs = splitAtTransitGaps(points);
    detectedTransitGaps += pointLegs.length - 1;
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
      if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) {
        excludedForDuration++;
        continue;
      }
      races.push(buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment));
      raceDates.push(pointLegs.length > 1 ? (legPoints[0]?.time ?? runDate(run)) : runDate(run));
      raceLabels.push(run.name + (pointLegs.length > 1 ? " (leg)" : ""));
    }
  }

  console.log(
    `\nFetched ${candidates.length - fetchFailures}/${candidates.length} candidates (${fetchFailures} fetch failures), ` +
      `${detectedTransitGaps} transit gaps detected, ${excludedForDuration} legs excluded for duration < ${DURABILITY_MIN_DURATION_S / 60}min.`,
  );
  console.log(`${races.length} races feeding the fit.\n`);

  const durationsH = races.map((r) => {
    const last = r[r.length - 1];
    return last ? last.tHours + last.dtS / 3600 : 0;
  });
  const sortedDurations = [...durationsH].sort((a, b) => a - b);
  if (sortedDurations.length > 0) {
    const shortest = sortedDurations[0];
    const longest = sortedDurations[sortedDurations.length - 1];
    console.log(`Duration range: ${shortest.toFixed(2)}h - ${longest.toFixed(2)}h (${(longest / shortest).toFixed(1)}x longest/shortest)\n`);
  }

  const safeFit = fitTauFInfWithSupportGate(races, ceilingParams, { raceDates });
  console.log(`=== fitTauFInfWithSupportGate result ===`);
  console.log(`Tier applied: ${safeFit.tier}`);
  console.log(`Applied ceilingParams: tauMin=${safeFit.ceilingParams.tauMin} fInf=${safeFit.ceilingParams.fInf}\n`);

  if (safeFit.tauFit) {
    console.log(
      `Tau-only fit: tauMin=${safeFit.tauFit.tauMin} informative=${safeFit.tauFit.informativeRaceCount}/${safeFit.tauFit.perRace.length} ` +
        `hitSearchBoundary=${safeFit.tauFit.hitSearchBoundary}`,
    );
  } else {
    console.log("Tau-only fit: null");
  }

  if (safeFit.fInfFit) {
    console.log(
      `Joint fInf/tau fit: fInf=${safeFit.fInfFit.fInf} tauMin=${safeFit.fInfFit.tauMin} ` +
        `durationDiversityRatio=${safeFit.fInfFit.durationDiversityRatio.toFixed(2)} ` +
        `informative=${safeFit.fInfFit.informativeRaceCount}/${safeFit.fInfFit.perRace.length} ` +
        `hitSearchBoundary=fInf:${safeFit.fInfFit.hitSearchBoundary.fInf} tau:${safeFit.fInfFit.hitSearchBoundary.tau}`,
    );
  } else {
    console.log("Joint fInf/tau fit: null");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
