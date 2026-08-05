// Follow-up to investigateRunSelectionSensitivity.ts's cap sweep, which
// varied suggestRunsForFit's per-bucket candidateCount and the total cap
// together (both called `cap`) -- conflating two different knobs. This
// isolates them: keeps the per-bucket pool at the real production value
// (60, generous on purpose) and only raises the TOTAL cap, to find out
// whether Ecotrail 80 (missing from the informative set at cap=60) is
// merely crowded out by the total-cap slice, or never makes the per-bucket
// list at all -- that distinction decides which constant actually needs to
// change.
//
// Usage: npx tsx scripts/decoupledCapSweep.ts [--since=2025-01-01]
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
const PER_BUCKET_COUNT = 60; // fixed at the real production value throughout
const MIN_LEG_DISTANCE_KM = 5;

function interleave<T>(lists: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) if (i < list.length) result.push(list[i]);
  }
  return result;
}

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    /* offline */
  }
  const runs = await backfill(BASE_URL, cookie, SINCE_DATE, { offline: true });
  const { kept } = dedupeStoredRuns(runs);

  const suggestions = suggestRunsForFit(kept, PER_BUCKET_COUNT);
  console.log(`Per-bucket pool (fixed at ${PER_BUCKET_COUNT}): vo2max=${suggestions.vo2max.length} durability=${suggestions.durability.length} durationSpread=${suggestions.durationSpread.length}`);

  const interleaved = interleave([suggestions.vo2max, suggestions.durability, suggestions.durationSpread]);
  const byId = new Map<string, StoredRun>();
  for (const r of interleaved) if (!byId.has(r.id)) byId.set(r.id, r);
  const ranked = [...byId.values()];

  for (const [label, pred] of [
    ["Ecotrail 80", (r: StoredRun) => r.name.includes("Ecotrail")],
    ["Ås Backyard ultra", (r: StoredRun) => r.name.includes("Backyard")],
    ["Soria Moria", (r: StoredRun) => r.name.includes("Soria Moria")],
  ] as const) {
    const rank = ranked.findIndex(pred);
    console.log(
      `${label}: vo2max=${suggestions.vo2max.some(pred)} durability=${suggestions.durability.some(pred)} ` +
        `durationSpread=${suggestions.durationSpread.some(pred)} -- combined rank: ${rank === -1 ? "not present" : rank + 1} of ${ranked.length}`,
    );
  }
  console.log();

  for (const totalCap of [60, 70, 80, 90]) {
    const candidates = ranked.slice(0, totalCap);
    const races: EffortTrendPoint[][] = [];
    const dates: (Date | null)[] = [];
    for (const run of candidates) {
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
        if (analysis.totalMovingTimeS < DURABILITY_MIN_DURATION_S) continue;
        races.push(buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment));
        dates.push(pointLegs.length > 1 ? (legPoints[0]?.time ?? (run.date ? new Date(run.date) : null)) : run.date ? new Date(run.date) : null);
      }
    }
    const fit = fitFInfAndTauAcrossRaces(races, ceilingParams, { raceDates: dates });
    const hasBackyard = candidates.some((r) => r.name.includes("Backyard"));
    if (!fit) {
      console.log(`totalCap=${totalCap}: n=${races.length} backyardIncluded=${hasBackyard} -- fit null`);
      continue;
    }
    console.log(
      `totalCap=${totalCap}: n=${races.length} backyardIncluded=${hasBackyard} tau=${fit.tauMin}min fInf=${fit.fInf} informative=${fit.informativeRaceCount}/${fit.perRace.length}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
