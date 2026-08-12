// Re-runs the descent/intensity-vs-fade diagnostics (tauDiagnostic.ts +
// withinRaceDescentDiagnostic.ts) at the full scale of the run library now
// available -- both were built and tested earlier in this project (PLAN.md
// §12/§13) and last re-checked 2026-07-22 at n=16, where the within-race
// descent correlation had WEAKENED as data grew (-0.58/-0.39/-0.23 at n=7
// -> -0.21/-0.21/-0.22 at n=16) -- PLAN.md's own read: "a real, robust
// effect should firm up with more independent data, not fade toward zero
// ... this does not clear the bar for a model change." This reruns the
// same unmodified diagnostic code against the much larger cached pool from
// this session's fade-signal investigation, to see whether that fade
// continues or reverses.
//
// Leads with computeWithinRaceDescentDiagnostic (within-race, controls for
// duration by comparing each race to itself) -- computeTauDiagnostic
// (whole-race, tau vs. avgIntensity/descent) is reported second since it
// carries the duration/intensity confound its own header documents and
// needs a reliable PER-RACE solo tau fit (long races only).
//
// Usage: npx tsx scripts/rerunDescentIntensityDiagnostic.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { computeTauDiagnostic, type RaceDiagnosticPoint } from "../src/model/tauDiagnostic.ts";
import { buildRaceDiagnosticPoint } from "../src/model/raceDiagnosticPoint.ts";
import {
  buildWithinRaceDiagnosticPoint,
  computeWithinRaceDescentDiagnostic,
  type WithinRaceDiagnosticPoint,
} from "../src/model/withinRaceDescentDiagnostic.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);
const analysisInputs = {
  bodyMassKg: formInputs.bodyMassKg,
  ceilingParams,
  fueling: { intakeGPerH: formInputs.intakeGPerH },
  glycogenStoreG: resolveGlycogenStoreG(formInputs),
  walkMaxMs: formInputs.walkMaxMs,
  altitudeAdjustment: formInputs.altitudeAdjustment,
};

function fmt(r: number | null): string {
  return r === null ? "n/a" : r.toFixed(2);
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

  const wholeRacePoints: RaceDiagnosticPoint[] = [];
  const withinRacePoints: WithinRaceDiagnosticPoint[] = [];
  let racesConsidered = 0;

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
      racesConsidered++;
      const label = run.name + (pointLegs.length > 1 ? " (leg)" : "");

      const wholeRacePoint = buildRaceDiagnosticPoint(label, course, analysisInputs);
      if (wholeRacePoint) wholeRacePoints.push(wholeRacePoint);

      const withinRacePoint = buildWithinRaceDiagnosticPoint(label, course, analysisInputs);
      if (withinRacePoint) withinRacePoints.push(withinRacePoint);
    }
  }

  console.log(`${racesConsidered} race legs considered.\n`);

  // ---- Lead: within-race (controls for duration by construction) ----
  console.log(`=== Within-race descent diagnostic (n=${withinRacePoints.length}) ===`);
  console.log(`Prior reads: -0.58/-0.39/-0.23 at n=7 (2026 earlier) -> -0.21/-0.21/-0.22 at n=16 (2026-07-22), running impact +0.19 at n=16.\n`);
  if (withinRacePoints.length > 0) {
    const result = computeWithinRaceDescentDiagnostic(withinRacePoints);
    console.log(`late residual vs early descent:            ${fmt(result.lateResidualVsEarlyDescentCorrelation)}`);
    console.log(`late residual vs early descent impact:      ${fmt(result.lateResidualVsEarlyDescentImpactCorrelation)}`);
    console.log(`late residual vs early descent impact²:     ${fmt(result.lateResidualVsEarlyDescentImpactSquaredCorrelation)}`);
    console.log(`late residual vs early running impact:      ${fmt(result.lateResidualVsEarlyRunningImpactCorrelation)} (predicted sign: positive)`);
    console.log(`late residual vs early net work:             ${fmt(result.lateResidualVsEarlyNetWorkCorrelation)} (negative-split confound -- see file header)`);
    console.log(`late residual vs early hard work:            ${fmt(result.lateResidualVsEarlyHardWorkCorrelation)} (negative-split confound -- see file header)`);
    console.log("\nPer-race points:");
    for (const p of withinRacePoints) {
      console.log(`  ${p.label.padEnd(30)} lateResidual=${p.lateResidualTrendPctPerHour.toFixed(1)}%/h  earlyDescent=${p.earlyDescentPerKm.toFixed(0)}m/km`);
    }
  } else {
    console.log("No races qualified (need a reliable whole-race solo tau fit + a late window >=1h).");
  }

  // ---- Secondary: whole-race tau vs intensity/descent ----
  console.log(`\n=== Whole-race tau diagnostic (n=${wholeRacePoints.length}) ===`);
  console.log(`Prior read: intensity correlation -0.60 at n=12 (self-consistent-tau fix).\n`);
  if (wholeRacePoints.length > 0) {
    const result = computeTauDiagnostic(wholeRacePoints);
    console.log(`tau vs avg intensity:          ${fmt(result.intensityCorrelation)}`);
    console.log(`tau vs descent/km:             ${fmt(result.descentCorrelation)}`);
    console.log(`tau vs descent impact/km:      ${fmt(result.descentImpactCorrelation)}`);
    console.log(`tau vs descent impact²/km:     ${fmt(result.descentImpactSquaredCorrelation)}`);
    console.log("\nPer-race points:");
    for (const p of wholeRacePoints) {
      console.log(`  ${p.label.padEnd(30)} tau=${p.tauMin}min  intensity=${(p.avgIntensity * 100).toFixed(0)}%  descent=${p.descentPerKm.toFixed(0)}m/km`);
    }
  } else {
    console.log("No races qualified (need a reliable solo whole-race tau fit).");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
