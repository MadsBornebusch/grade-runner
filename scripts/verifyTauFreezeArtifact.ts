// Sanity check on prototypeFInfFromExpandedPool.ts's headline result: that
// script froze tau at the long-race value (295) in every leave-one-out
// fold of the expanded-pool arm, so fInf landing at ~0.579 in every fold
// could just mean "we froze the fragile parameter", not "the expanded fInf
// estimate is robust". This redoes the same leave-one-out folds but
// re-fits tau JOINTLY on the expanded (>=120min) pool each time (i.e.
// Arm A's approach, per fold) instead of freezing it, to see whether fInf
// actually moves once tau is allowed to respond to which race was held out.
// Also reports each fold's tau search bounds (tauLo/tauHi, derived from
// pacingFit.ts's own formula) next to the fitted tau, to check whether the
// wild historical swings (59min / 279min / 3867min) were landing on the
// search boundary itself rather than a genuine interior optimum.
//
// Usage: npx tsx scripts/verifyTauFreezeArtifact.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import {
  buildEffortTrendPoints,
  fitFInfAndTauAcrossRaces,
  MIN_FIT_POINTS,
  trimForPacingFit,
  type EffortTrendPoint,
} from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;
const EXPANDED_POOL_MIN_DURATION_MIN = 120;
const ABSOLUTE_MAX_TAU_MIN = 5000; // mirrors pacingFit.ts's own private constant

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);

interface Race {
  id: string;
  name: string;
  points: EffortTrendPoint[];
  date: Date | null;
  durationMin: number;
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

  const longRaceNames = ["Soria Moria", "Backyard", "Ecotrail"];
  console.log("=== Re-fit tau JOINTLY per fold (expanded >=120min pool, Arm A logic, per LOO fold) ===\n");
  for (const nameFragment of longRaceNames) {
    const heldOut = races.find((r) => r.name.includes(nameFragment));
    if (!heldOut) continue;

    const foldRaces = races.filter((r) => r.id !== heldOut.id);
    const rawRaces = foldRaces.map((r) => r.points);
    const raceDates = foldRaces.map((r) => r.date);

    const longestOtherMin = Math.max(...foldRaces.map((r) => r.durationMin));
    const shortestInPoolMin = Math.min(...foldRaces.filter((r) => r.durationMin >= EXPANDED_POOL_MIN_DURATION_MIN).map((r) => r.durationMin));
    const tauLo = Math.max(20, shortestInPoolMin * 0.3);
    const tauHi = Math.min(ABSOLUTE_MAX_TAU_MIN, longestOtherMin * 2.5);

    const fit = fitFInfAndTauAcrossRaces(rawRaces, { ...ceilingParams, tauMin: EXPANDED_POOL_MIN_DURATION_MIN }, { raceDates });
    console.log(
      `${heldOut.name.padEnd(28)} tau=${fit?.tauMin} fInf=${fit?.fInf}  (search bounds ~[${tauLo.toFixed(0)}, ${tauHi.toFixed(0)}]min, ` +
        `hitBoundary=fInf:${fit?.hitSearchBoundary.fInf ?? "no"},tau:${fit?.hitSearchBoundary.tau ?? "no"})  informative=${fit?.informativeRaceCount}/${fit?.perRace.length}`,
    );
  }

  console.log("\n=== For comparison: shipped (250min floor) LOO tau search bounds, to check if 59/279/3867 hit the boundary ===\n");
  for (const nameFragment of longRaceNames) {
    const heldOut = races.find((r) => r.name.includes(nameFragment));
    if (!heldOut) continue;
    const foldRaces = races.filter((r) => r.id !== heldOut.id);
    const rawRaces = foldRaces.map((r) => r.points);
    const raceDates = foldRaces.map((r) => r.date);
    const longestOtherMin = Math.max(...foldRaces.map((r) => r.durationMin));
    const tauHi = Math.min(ABSOLUTE_MAX_TAU_MIN, longestOtherMin * 2.5);
    const fit = fitFInfAndTauAcrossRaces(rawRaces, ceilingParams, { raceDates });
    console.log(
      `${heldOut.name.padEnd(28)} tau=${fit?.tauMin} fInf=${fit?.fInf}  tauHi bound=${tauHi.toFixed(0)}min  hitBoundary=fInf:${fit?.hitSearchBoundary.fInf ?? "no"},tau:${fit?.hitSearchBoundary.tau ?? "no"}` +
        `  longest-remaining-race=${longestOtherMin.toFixed(0)}min`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
