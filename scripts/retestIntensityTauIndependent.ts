// Re-tests the whole-race tau-vs-intensity correlation (-0.60 at n=12,
// -0.39 at n=116 in this session's rerunDescentIntensityDiagnostic.ts) with
// TWO tau-independent intensity measures, to check whether it survives once
// the self-referential confound is removed: raceDiagnosticPoint.ts's
// avgIntensity is power divided by each race's own FITTED, tau-decaying
// ceiling -- a smaller fitted tau mechanically produces a higher intensity
// reading for identical power output, so a negative tau-vs-intensity
// correlation could be substantially a byproduct of the metric's own
// construction rather than a real physiological relationship.
//
//   1. HR-zone relative: avg heart rate / threshold HR, using the athlete's
//      OWN Strava-computed zone boundaries (mcp__strava-mcp__get_athlete_zones,
//      an independent source, unrelated to this app's ceiling model at all).
//      Zone 4's lower bound is the conventional "threshold" boundary in a
//      5-zone model.
//   2. Fresh-ceiling relative: avg grossPowerWPerKg / ceilingPower at tMin=0
//      (fully tau-independent -- ceiling.ts's sustainableFraction(0, params)
//      only involves f0/lt2Fraction, both fixed constants, never tauMin).
//      Still internal to this app's model, but structurally can't carry the
//      same circularity as the original metric.
//
// Uses the same population (races with a reliable solo whole-race tau fit,
// no boundary hit) as the original diagnostic, so only the intensity
// metric changes, not which races qualify.
//
// Usage: npx tsx scripts/retestIntensityTauIndependent.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower } from "../src/model/ceiling.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { buildEffortTrendPoints, fitTauMinutes } from "../src/model/pacingFit.ts";
import { pearsonCorrelation } from "../src/model/tauDiagnostic.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;

// From mcp__strava-mcp__get_athlete_zones -- heart_rate_zones[3].min is
// zone 4's lower bound, the conventional "threshold" boundary in a 5-zone
// model (zone 4 = threshold, zone 5 = VO2max/anaerobic).
const THRESHOLD_HR_BPM = 165;

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);
const freshCeilingWPerKg = ceilingPower({ tMin: 0, altitudeM: 0, elapsedHours: 0 }, ceilingParams);

async function main() {
  let cookie = "";
  try {
    cookie = loadCookie(SESSION_FILE, BASE_URL);
  } catch {
    console.log("No .strava-session.local -- proceeding offline (cached data only).\n");
  }

  const runs = await backfill(BASE_URL, cookie, SINCE_DATE).catch(() => backfill(BASE_URL, cookie, SINCE_DATE, { offline: true }));
  const { kept } = dedupeStoredRuns(runs);

  interface Point {
    label: string;
    tauMin: number;
    oldSelfReferentialIntensity: number;
    freshCeilingIntensity: number;
    hrThresholdIntensity: number | null;
  }
  const points: Point[] = [];

  for (const run of kept) {
    if (run.stravaId === undefined) continue;
    let raw;
    try {
      raw = await fetchActivityPoints(BASE_URL, cookie, run.stravaId);
    } catch {
      continue;
    }
    const pointLegs = splitAtTransitGaps(raw.points);
    for (const legPoints of pointLegs) {
      const course = runPipeline(legPoints);
      if (!course.hasTimestamps) continue;
      const distanceKm = course.totalDistance3D / 1000;
      if (distanceKm <= 0) continue;
      if (pointLegs.length > 1 && distanceKm < MIN_LEG_DISTANCE_KM) continue;

      const analysisInputs = {
        bodyMassKg: formInputs.bodyMassKg,
        ceilingParams,
        fueling: { intakeGPerH: formInputs.intakeGPerH },
        glycogenStoreG: resolveGlycogenStoreG(formInputs),
        walkMaxMs: formInputs.walkMaxMs,
        altitudeAdjustment: formInputs.altitudeAdjustment,
      };
      const analysis = analyzeRun(course.segments, analysisInputs);
      const trendPoints = buildEffortTrendPoints(course.segments, analysis.segments, formInputs.altitudeAdjustment);
      const soloTauFit = fitTauMinutes(trendPoints, ceilingParams);
      if (!soloTauFit || soloTauFit.hitSearchBoundary) continue;

      // Self-consistent, as raceDiagnosticPoint.ts does it -- against THIS
      // race's own fitted tau (the confound under test).
      const selfConsistentAnalysis = analyzeRun(course.segments, {
        ...analysisInputs,
        ceilingParams: { ...ceilingParams, tauMin: soloTauFit.tauMin },
      });

      const sumW = trendPoints.reduce((a, p) => a + p.dtS, 0);
      if (sumW <= 0) continue;
      const freshCeilingIntensity = trendPoints.reduce((a, p) => a + p.grossPowerWPerKg * p.dtS, 0) / sumW / freshCeilingWPerKg;

      const hrPoints = trendPoints.filter((p) => p.heartRateBpm !== undefined);
      const hrSumW = hrPoints.reduce((a, p) => a + p.dtS, 0);
      const hrThresholdIntensity =
        hrPoints.length >= 3 && hrSumW > 0
          ? hrPoints.reduce((a, p) => a + p.heartRateBpm! * p.dtS, 0) / hrSumW / THRESHOLD_HR_BPM
          : null;

      points.push({
        label: run.name + (pointLegs.length > 1 ? " (leg)" : ""),
        tauMin: soloTauFit.tauMin,
        oldSelfReferentialIntensity: selfConsistentAnalysis.avgEffortFraction,
        freshCeilingIntensity,
        hrThresholdIntensity,
      });
    }
  }

  console.log(`${points.length} races with a reliable solo whole-race tau fit.\n`);

  const tauVals = points.map((p) => p.tauMin);
  console.log("=== Correlations with tau ===");
  console.log(`old self-referential intensity (power/OWN-fitted-decaying-ceiling): ${pearsonCorrelation(tauVals, points.map((p) => p.oldSelfReferentialIntensity))?.toFixed(3)}  (n=${points.length})`);
  console.log(`fresh-ceiling intensity (power/FRESH-t=0-ceiling, tau-independent): ${pearsonCorrelation(tauVals, points.map((p) => p.freshCeilingIntensity))?.toFixed(3)}  (n=${points.length})`);

  const withHr = points.filter((p) => p.hrThresholdIntensity !== null);
  console.log(
    `HR/threshold intensity (Strava's own zones, fully independent of this app's model): ${pearsonCorrelation(withHr.map((p) => p.tauMin), withHr.map((p) => p.hrThresholdIntensity!))?.toFixed(3)}  (n=${withHr.length})`,
  );

  console.log("\nPer-race points (sorted by tau):");
  for (const p of [...points].sort((a, b) => a.tauMin - b.tauMin)) {
    console.log(
      `  ${p.label.padEnd(30)} tau=${String(p.tauMin).padStart(5)}min  old=${(p.oldSelfReferentialIntensity * 100).toFixed(0)}%  fresh=${(p.freshCeilingIntensity * 100).toFixed(0)}%  hr=${p.hrThresholdIntensity ? (p.hrThresholdIntensity * 100).toFixed(0) + "%" : "n/a"}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
