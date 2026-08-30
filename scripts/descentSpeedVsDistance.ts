// Ad hoc diagnostic for a user question: does this athlete's actual
// descent-running speed scale with a RACE's total distance (a deliberate,
// chosen-at-the-start pacing decision -- "don't blow the legs on a 100k
// descent the way you would on a 10k one"), or with how much distance is
// ALREADY covered within a single run (an on-the-fly fatigue decay)? The
// current model's maxDescentSpeedMs (minetti.ts) is a single flat constant
// per grade, regardless of either -- this checks whether the real data
// supports making it distance-of-the-day dependent instead.
//
// Runs entirely offline against .strava-cache/ -- only activities already
// cached (points fetched by some earlier script run) are usable here; no
// live Strava/vercel dev needed.
//
// Usage: npx tsx scripts/descentSpeedVsDistance.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/gpx/pipeline.ts";
import { maxDescentSpeedMs } from "../src/model/minetti.ts";
import { looksLikeGenericStravaTitle } from "../src/model/raceCandidates.ts";
import type { GpxPoint } from "../src/gpx/pipeline.ts";

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

interface ActivityMeta {
  id: string;
  name: string;
  stravaId: number;
  date: string;
  distanceKm: number;
  elevationGainM: number;
}

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

export function loadCachedPoints(stravaId: number): GpxPoint[] | null {
  const path = `${CACHE_DIR}activity-${stravaId}.json`;
  if (!existsSync(path)) return null;
  const cached = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  return cached.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
}

interface DescentStats {
  /** Distance-weighted average actual speed on descent-cap-eligible
   * segments (gradient steep enough for maxDescentSpeedMs to be finite). */
  avgActualSpeedMs: number;
  /** Same, but the model's own cap at each segment's gradient -- fixed
   * regardless of race distance, so this is really just a sanity readout,
   * not something that varies per race. */
  avgCapSpeedMs: number;
  /** Fraction of cap-eligible descent distance run FASTER than the cap. */
  fractionOverCap: number;
  cappedSegmentDistanceM: number;
}

export function computeDescentStats(points: GpxPoint[]): DescentStats | null {
  const course = runPipeline(points);
  let weightedActual = 0;
  let weightedCap = 0;
  let overCapDistanceM = 0;
  let totalDistanceM = 0;
  for (const seg of course.segments) {
    const cap = maxDescentSpeedMs(seg.gradient);
    if (!Number.isFinite(cap)) continue;
    if (seg.dtS === null || seg.dtS <= 0 || seg.paused) continue;
    const speed = seg.distance3D / seg.dtS;
    weightedActual += speed * seg.distance3D;
    weightedCap += cap * seg.distance3D;
    totalDistanceM += seg.distance3D;
    if (speed > cap) overCapDistanceM += seg.distance3D;
  }
  if (totalDistanceM <= 0) return null;
  return {
    avgActualSpeedMs: weightedActual / totalDistanceM,
    avgCapSpeedMs: weightedCap / totalDistanceM,
    fractionOverCap: overCapDistanceM / totalDistanceM,
    cappedSegmentDistanceM: totalDistanceM,
  };
}

/** Pearson correlation coefficient. */
function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  return cov / Math.sqrt(varX * varY);
}

/**
 * Manual judgment call, same discipline predictARaces.ts's own
 * CONFIRMED_RACE_NAMES documents in its header comment: named-and-cached
 * isn't the same as "a race" -- these are structured/deliberately-easy
 * training sessions (an interval workout, a repeated fixed loop, and a run
 * literally named "long and slow" in Norwegian) that happen to have real
 * elevation change and a real name. Their deliberately-restrained descent
 * pacing would bias a fit that's trying to isolate RACE-day pacing
 * specifically. Kept in the printed table (so the exclusion is visible and
 * correctable) but dropped from the correlation/fit.
 */
const NOT_A_RACE = new Set(["Evening Intervals", "2.5 km loop every hour", "Langt Og Langsomt"]);

export interface RaceDescentRatio {
  name: string;
  date: string;
  distanceKm: number;
  ratio: number;
}

/** Loads this athlete's real races (see NOT_A_RACE above) with usable
 * descent-cap-eligible data, for fitDescentPacingMultiplier.ts's fit. */
export function loadRaceDescentRatios(): RaceDescentRatio[] {
  const activities = JSON.parse(readFileSync(`${CACHE_DIR}activities.json`, "utf8")) as ActivityMeta[];
  const cachedIds = new Set(
    readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith("activity-"))
      .map((f) => Number(f.slice("activity-".length, -".json".length))),
  );
  const candidates = activities
    .filter((a) => cachedIds.has(a.stravaId))
    .filter((a) => a.distanceKm >= 3 && a.elevationGainM >= 50)
    .filter((a) => !looksLikeGenericStravaTitle(a.name))
    .filter((a) => !NOT_A_RACE.has(a.name));

  const out: RaceDescentRatio[] = [];
  for (const a of candidates) {
    const points = loadCachedPoints(a.stravaId);
    if (!points) continue;
    const stats = computeDescentStats(points);
    if (!stats || stats.cappedSegmentDistanceM < 200) continue;
    out.push({ name: a.name, date: a.date.slice(0, 10), distanceKm: a.distanceKm, ratio: stats.avgActualSpeedMs / stats.avgCapSpeedMs });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

async function main() {
  const activities = JSON.parse(readFileSync(`${CACHE_DIR}activities.json`, "utf8")) as ActivityMeta[];
  const cachedIds = new Set(
    readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith("activity-"))
      .map((f) => Number(f.slice("activity-".length, -".json".length))),
  );

  // Candidates: real distance (>=3km, so there's enough descent to measure),
  // meaningful elevation loss (>=50m, so cap-eligible segments actually
  // exist), a real chosen name (not a generic Strava auto-title -- the
  // athlete's own heuristic for "this was probably a race or a run worth
  // naming", not necessarily a confirmed race, but a reasonable proxy given
  // StoredRun.raceTag isn't recoverable from Strava alone), and already
  // cached locally.
  const candidates = activities
    .filter((a) => cachedIds.has(a.stravaId))
    .filter((a) => a.distanceKm >= 3 && a.elevationGainM >= 50)
    .filter((a) => !looksLikeGenericStravaTitle(a.name));

  console.log(`${candidates.length} named, cached, >=3km candidates with real elevation change out of ${activities.length} total activities.\n`);

  const rows: { name: string; date: string; distanceKm: number; stats: DescentStats }[] = [];
  for (const a of candidates) {
    const points = loadCachedPoints(a.stravaId);
    if (!points) continue;
    const stats = computeDescentStats(points);
    if (!stats || stats.cappedSegmentDistanceM < 200) continue; // not enough descent to be informative
    rows.push({ name: a.name, date: a.date.slice(0, 10), distanceKm: a.distanceKm, stats });
  }

  rows.sort((a, b) => a.distanceKm - b.distanceKm);

  console.log(
    "Distance(km)  Date        Actual descent speed (m/s)  Cap (m/s)  Actual/Cap  %distance over cap   Name",
  );
  for (const r of rows) {
    const ratio = r.stats.avgActualSpeedMs / r.stats.avgCapSpeedMs;
    const excluded = NOT_A_RACE.has(r.name) ? "  [excluded from fit -- not a race]" : "";
    console.log(
      `${r.distanceKm.toFixed(1).padStart(11)}  ${r.date}  ${r.stats.avgActualSpeedMs.toFixed(2).padStart(24)}  ` +
        `${r.stats.avgCapSpeedMs.toFixed(2).padStart(9)}  ${ratio.toFixed(2).padStart(9)}  ` +
        `${(r.stats.fractionOverCap * 100).toFixed(0).padStart(18)}%   ${r.name}${excluded}`,
    );
  }

  const raceRows = rows.filter((r) => !NOT_A_RACE.has(r.name));
  const xs = raceRows.map((r) => r.distanceKm);
  const ysActual = raceRows.map((r) => r.stats.avgActualSpeedMs);
  const ysRatio = raceRows.map((r) => r.stats.avgActualSpeedMs / r.stats.avgCapSpeedMs);
  console.log(`\n${raceRows.length} real races analyzed (${rows.length - raceRows.length} non-race training sessions excluded), spanning ${Math.min(...xs).toFixed(1)}km to ${Math.max(...xs).toFixed(1)}km.`);
  console.log(`Correlation(total distance, actual descent speed):        r = ${correlation(xs, ysActual).toFixed(3)}`);
  console.log(`Correlation(total distance, actual/cap speed ratio):      r = ${correlation(xs, ysRatio).toFixed(3)}`);

  // Within-run trend: for the 3 longest runs with enough cap-eligible
  // segments, check whether descent speed trends down with cumulative
  // distance ALREADY COVERED in that same run (fatigue-driven decay) as
  // opposed to being roughly flat throughout (consistent with a pace chosen
  // up front for the whole distance, not decided mid-run).
  console.log("\nWithin-run trend (does descent speed fall off as distance-so-far increases, WITHIN one run?):");
  const longest = [...raceRows].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 3);
  for (const r of longest) {
    const a = candidates.find((c) => c.name === r.name && c.date.slice(0, 10) === r.date);
    if (!a) continue;
    const points = loadCachedPoints(a.stravaId);
    if (!points) continue;
    const course = runPipeline(points);
    const distancesKm: number[] = [];
    const speeds: number[] = [];
    for (const seg of course.segments) {
      const cap = maxDescentSpeedMs(seg.gradient);
      if (!Number.isFinite(cap) || seg.dtS === null || seg.dtS <= 0 || seg.paused) continue;
      distancesKm.push(seg.cumulativeDistance3D / 1000);
      speeds.push(seg.distance3D / seg.dtS);
    }
    if (distancesKm.length < 20) continue;
    console.log(
      `  ${r.name} (${r.distanceKm.toFixed(1)}km, ${distancesKm.length} cap-eligible segments): ` +
        `correlation(distance-so-far, descent speed) = ${correlation(distancesKm, speeds).toFixed(3)}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
