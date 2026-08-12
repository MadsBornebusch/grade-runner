// Follow-up to prototypeFInfFromExpandedPool.ts: Arm B's fInf (0.579 on the
// expanded >=2h pool) differs substantially from the narrow, long-race-only
// value (0.742 at the same fixed tau). Before trusting the expanded-pool
// number, check the obvious confound: 2-4h efforts include both genuine
// races AND ordinary training runs, and training runs are far more likely
// to be deliberately paced (progression runs, warmup-then-steady, negative
// splits) rather than all-out efforts that fade the way a race does. If
// fInf estimated from JUST the training-run-labeled 2-4h entries differs
// sharply from JUST the race-labeled ones, that's the confound, and the
// fix is "restrict the expanded pool to genuine race efforts", not "any
// run >=2h".
//
// Classification is a naive heuristic (Strava's own auto-generated name
// pattern for un-retitled training runs vs. a real event name) -- good
// enough to see if there's a large, obvious split, not a rigorous label.
//
// Usage: npx tsx scripts/investigate2to4hConfound.ts [--since=2024-01-01]
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { dedupeStoredRuns } from "../src/model/dedupeRuns.ts";
import { buildEffortTrendPoints, computeEffortTrend, trimForPacingFit, MIN_FIT_POINTS } from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg, backfill, fetchActivityPoints, loadCookie } from "./stravaScriptHelpers.ts";

const BASE_URL = arg("base", "http://localhost:3000");
const SINCE_DATE = new Date(arg("since", "2024-01-01"));
const SESSION_FILE = fileURLToPath(new URL("../.strava-session.local", import.meta.url));
const MIN_LEG_DISTANCE_KM = 5;
const BAND_LO_MIN = 120;
const BAND_HI_MIN = 240;

const formInputs = DEFAULT_FORM_INPUTS;
const ceilingParams = resolveCeilingParams(formInputs);

// Strava's own auto-generated title for an un-retitled activity: a
// time-of-day word, optionally "Trail", then "Run" -- everything else
// (a custom title) is treated as a real named event.
const AUTO_TITLE_PATTERN = /^(Morning|Afternoon|Evening|Night|Lunch)\s+(Trail\s+)?Run(\s*\(leg\))?$/i;
function isLikelyNamedEvent(name: string): boolean {
  return !AUTO_TITLE_PATTERN.test(name.trim());
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

  interface BandRace {
    name: string;
    isNamedEvent: boolean;
    durationMin: number;
    earlyAvgPowerWPerKg: number;
    lateAvgPowerWPerKg: number;
    splitRatio: number; // late/early -- >1 = negative split (sped up), <1 = positive split (faded)
    fadeRatePctPerHour: number | null;
  }
  const bandRaces: BandRace[] = [];

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
      const durationMin = trimmed[trimmed.length - 1].tHours * 60;
      if (durationMin < BAND_LO_MIN || durationMin >= BAND_HI_MIN) continue;

      const midHours = trimmed[0].tHours + (trimmed[trimmed.length - 1].tHours - trimmed[0].tHours) / 2;
      const early = trimmed.filter((p) => p.tHours < midHours);
      const late = trimmed.filter((p) => p.tHours >= midHours);
      if (early.length < 3 || late.length < 3) continue;
      const wavg = (pts: typeof trimmed) => {
        const sumW = pts.reduce((a, p) => a + p.dtS, 0);
        return pts.reduce((a, p) => a + p.grossPowerWPerKg * p.dtS, 0) / sumW;
      };
      const earlyAvg = wavg(early);
      const lateAvg = wavg(late);
      const trend = computeEffortTrend(trimmed, ceilingParams);

      bandRaces.push({
        name: run.name + (pointLegs.length > 1 ? " (leg)" : ""),
        isNamedEvent: isLikelyNamedEvent(run.name),
        durationMin,
        earlyAvgPowerWPerKg: earlyAvg,
        lateAvgPowerWPerKg: lateAvg,
        splitRatio: lateAvg / earlyAvg,
        fadeRatePctPerHour: trend ? trend.slopePerHour * 100 : null,
      });
    }
  }

  console.log(`${bandRaces.length} races in the ${BAND_LO_MIN}-${BAND_HI_MIN}min band.\n`);
  console.log("Name                              event?  duration  split(late/early)  fadeRate%/h");
  for (const r of bandRaces.sort((a, b) => a.splitRatio - b.splitRatio)) {
    console.log(
      `${r.name.padEnd(34)} ${(r.isNamedEvent ? "yes" : "no").padEnd(6)}  ${r.durationMin.toFixed(0).padStart(6)}m  ${r.splitRatio.toFixed(3).padStart(8)}          ${r.fadeRatePctPerHour?.toFixed(1).padStart(6)}`,
    );
  }

  const namedEvents = bandRaces.filter((r) => r.isNamedEvent);
  const trainingRuns = bandRaces.filter((r) => !r.isNamedEvent);
  function summarize(label: string, rs: BandRace[]) {
    if (rs.length === 0) {
      console.log(`${label}: n=0`);
      return;
    }
    const meanSplit = rs.reduce((a, r) => a + r.splitRatio, 0) / rs.length;
    const fades = rs.map((r) => r.fadeRatePctPerHour).filter((v): v is number => v !== null);
    const meanFade = fades.length ? fades.reduce((a, v) => a + v, 0) / fades.length : NaN;
    console.log(`${label}: n=${rs.length}  mean split(late/early)=${meanSplit.toFixed(3)} (${meanSplit < 1 ? "positive split, faded" : "negative split, sped up"})  mean fadeRate=${meanFade.toFixed(1)}%/h`);
  }
  console.log("\n=== Summary ===");
  summarize("Named events  ", namedEvents);
  summarize("Training runs ", trainingRuns);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
