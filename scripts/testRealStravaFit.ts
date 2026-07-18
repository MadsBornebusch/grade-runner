// Manual, ad hoc integration test against REAL Strava data via a live
// browser session cookie. Not part of the automated test suite -- needs a
// running `vercel dev` server plus a real, authenticated session, neither
// of which belong in CI. Exercises the same real code (suggestRunsForFit,
// runPipeline, analyzeRun, fitTauAcrossRaces, fitFInfAndTauAcrossRaces) the
// UI calls, just driven from a script instead of clicking through
// RunLibraryPanel by hand.
//
// Setup (one-time):
//   1. `npx vercel dev` in one terminal.
//   2. Log in to Strava through the browser at that URL.
//   3. DevTools -> Application -> Cookies -> copy the `gr_session` value
//      (just the value, not the "gr_session=" prefix) into a new gitignored
//      file at the repo root: `.strava-session.local`.
//
// Usage:
//   npx tsx scripts/testRealStravaFit.ts [--base=http://localhost:3000] [--since=2024-01-01]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GpxPoint } from "../src/gpx/pipeline.ts";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { buildEffortTrendPoints, fitFInfAndTauAcrossRaces, fitTauAcrossRaces, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { buildRaceDiagnosticPoint } from "../src/model/raceDiagnosticPoint.ts";
import {
  filterRunsSinceDate,
  shouldFetchNextBackfillPage,
  toStoredRunSummaryInput,
  type BackfillPage,
} from "../src/model/stravaBackfill.ts";
import { suggestRunsForFit } from "../src/model/suggestRuns.ts";
import { computeTauDiagnostic, type RaceDiagnosticPoint } from "../src/model/tauDiagnostic.ts";
import type { StoredRun } from "../src/storage/runLibrary.ts";
import { DEFAULT_FORM_INPUTS, resolveVo2Max } from "../src/ui/formInputs.ts";

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MAX_BACKFILL_PAGES = 20;
const BACKFILL_PER_PAGE = 100;
const SUGGESTION_COUNT = 10;

function loadCookie(): string {
  try {
    return readFileSync(SESSION_FILE, "utf8").trim();
  } catch {
    throw new Error(
      `Missing ${SESSION_FILE}. Log in via the browser at ${BASE_URL}, copy the gr_session cookie value from ` +
        `DevTools (Application > Cookies), and save just that value (no "gr_session=" prefix) into that file.`,
    );
  }
}

async function fetchJson(path: string, cookie: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: `gr_session=${cookie}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

/** Mirrors stravaClient.ts's fetchStravaActivity -- `time` comes back as an
 * ISO string over JSON, parsed back to a Date here. */
interface WireGpxPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: string | null;
  hr: number | null;
  power: number | null;
}

async function fetchActivityPoints(cookie: string, stravaId: number): Promise<{ name: string; points: GpxPoint[] }> {
  const body = (await fetchJson(`/api/strava/activity?id=${stravaId}`, cookie)) as { name: string; points: WireGpxPoint[] };
  const points: GpxPoint[] = body.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  return { name: body.name, points };
}

/** Mirrors RunLibraryPanel.tsx's runBackfill loop, minus the IndexedDB
 * write -- runs are kept in memory only, for this one-off report. */
async function backfill(cookie: string, sinceDate: Date): Promise<StoredRun[]> {
  const runs: StoredRun[] = [];
  let page = 1;
  for (;;) {
    const body = (await fetchJson(
      `/api/strava/activities?page=${page}&per_page=${BACKFILL_PER_PAGE}`,
      cookie,
    )) as BackfillPage;
    for (const r of filterRunsSinceDate(body.runs, sinceDate)) {
      const input = toStoredRunSummaryInput(r);
      runs.push({
        id: `strava:${input.stravaId}`,
        name: input.name,
        addedAt: Date.now(),
        points: null,
        stravaId: input.stravaId,
        date: input.date,
        distanceKm: input.distanceKm,
        durationS: input.durationS,
        elevationGainM: input.elevationGainM,
        avgHeartRate: input.avgHeartRate,
        avgWatts: input.avgWatts,
      });
    }
    if (!shouldFetchNextBackfillPage(body, page, sinceDate, MAX_BACKFILL_PAGES)) break;
    page++;
  }
  return runs;
}

async function main() {
  const cookie = loadCookie();
  const formInputs = DEFAULT_FORM_INPUTS;
  // Same shape RunLibraryPanel.tsx builds -- default athlete params, not any
  // saved profile (this script has no access to localStorage).
  const ceilingParams = {
    vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory),
    lt2Fraction: formInputs.lt2Fraction,
    f0: formInputs.f0,
    fInf: formInputs.fInf,
    tauMin: formInputs.tauMin,
    durabilityDriftPerHour: formInputs.durabilityDriftPerHour,
  };

  console.log(`Backfilling run summaries since ${SINCE_DATE.toISOString().slice(0, 10)} from ${BASE_URL}...`);
  const runs = await backfill(cookie, SINCE_DATE);
  console.log(`Found ${runs.length} runs.\n`);

  const suggestions = suggestRunsForFit(runs, SUGGESTION_COUNT);
  console.log(
    `Suggested -- vo2max: ${suggestions.vo2max.length}, durability: ${suggestions.durability.length}, ` +
      `durationSpread: ${suggestions.durationSpread.length}`,
  );

  const byId = new Map(
    [...suggestions.vo2max, ...suggestions.durability, ...suggestions.durationSpread].map((r) => [r.id, r]),
  );
  const candidates = [...byId.values()];
  console.log(`Fetching full GPS data for ${candidates.length} candidate runs (deduped across buckets)...\n`);

  const races: EffortTrendPoint[][] = [];
  const raceDates: (Date | null)[] = [];
  const diagnosticPoints: RaceDiagnosticPoint[] = [];
  for (const run of candidates) {
    if (run.stravaId === undefined) continue;
    const { points } = await fetchActivityPoints(cookie, run.stravaId);
    const course = runPipeline(points);
    if (!course.hasTimestamps) {
      console.log(`  skipped (no timestamps): ${run.name}`);
      continue;
    }
    const analysisInputs = {
      bodyMassKg: formInputs.bodyMassKg,
      ceilingParams,
      fueling: { intakeGPerH: formInputs.intakeGPerH, gutMaxGPerH: formInputs.gutMaxGPerH },
      glycogenStoreG: formInputs.glycogenStoreG,
      reserveG: formInputs.reserveG,
      walkMaxMs: formInputs.walkMaxMs,
      altitudeAdjustment: formInputs.altitudeAdjustment,
    };
    const analysis = analyzeRun(course.segments, analysisInputs);
    races.push(buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment));
    raceDates.push(run.date ? new Date(run.date) : null);
    console.log(`  fetched: ${run.name} (${(course.totalDistance3D / 1000).toFixed(1)}km)`);

    // Self-consistent per race: avgIntensity is judged against THIS race's
    // own best-fit tau, not the one global default -- see
    // raceDiagnosticPoint.ts for why that matters (a long race read against
    // a too-short default tau reads as far more intense than it really was).
    const point = buildRaceDiagnosticPoint(run.name, course, analysisInputs);
    if (point) diagnosticPoints.push(point);
  }

  console.log(`\n${races.length} races with usable timestamps -- fitting...\n`);

  const tauFit = fitTauAcrossRaces(races, ceilingParams, { raceDates });
  console.log("Tau-only fit:", tauFit ? { tauMin: tauFit.tauMin, hitSearchBoundary: tauFit.hitSearchBoundary } : null);
  tauFit?.perRace.forEach((r, i) =>
    console.log(
      `  Run ${i + 1}: ${r.trendAtCurrentPctPerHour.toFixed(1)}%/h -> ${r.trendAtFitPctPerHour.toFixed(1)}%/h` +
        `${r.unresponsive ? " (unresponsive)" : ""}`,
    ),
  );

  const fInfFit = fitFInfAndTauAcrossRaces(races, ceilingParams, { raceDates });
  console.log(
    "\nExperimental fInf/tau fit:",
    fInfFit
      ? {
          fInf: fInfFit.fInf,
          tauMin: fInfFit.tauMin,
          durationDiversityRatio: fInfFit.durationDiversityRatio,
          hitSearchBoundary: fInfFit.hitSearchBoundary,
        }
      : null,
  );
  fInfFit?.perRace.forEach((r, i) =>
    console.log(
      `  Run ${i + 1}: ${r.trendAtCurrentPctPerHour.toFixed(1)}%/h -> ${r.trendAtFitPctPerHour.toFixed(1)}%/h` +
        `${r.unresponsive ? " (unresponsive)" : ""}`,
    ),
  );

  console.log(`\nTau-vs-intensity/descent diagnostic (${diagnosticPoints.length} races with a reliable solo tau fit, self-consistent avg effort):`);
  diagnosticPoints.forEach((p) =>
    console.log(
      `  ${p.label}: tau ${p.tauMin}min, ${(p.avgIntensity * 100).toFixed(0)}% avg effort, ` +
        `${p.descentPerKm.toFixed(0)} m/km descent`,
    ),
  );
  const diagnostic = computeTauDiagnostic(diagnosticPoints);
  console.log("\nCorrelations (tau vs. ...):");
  console.log(`  intensity:            ${diagnostic.intensityCorrelation?.toFixed(2) ?? "n/a"}`);
  console.log(`  descent:              ${diagnostic.descentCorrelation?.toFixed(2) ?? "n/a"}`);
  console.log(`  descent impact:       ${diagnostic.descentImpactCorrelation?.toFixed(2) ?? "n/a"}`);
  console.log(`  descent impact²:      ${diagnostic.descentImpactSquaredCorrelation?.toFixed(2) ?? "n/a"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
