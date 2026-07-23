// PLAN.md §14 Plan B, Stage 0 gate: does REAL device power (Stryd/footpod,
// CourseSegment.powerWatts) actually trace the Minetti cost curve across
// grade -- checked directly for the first time in this project. Every
// existing use of "power" elsewhere (analysis.ts's grossPowerWPerKg) is
// *derived from* GPS speed via costOfRunning/costOfWalking, so comparing
// that back to Minetti would be circular (at fixed grade, model-power *is*
// speed -- the same trap §12 stage 6's first path-multiplier attempt hit).
// This script uses only measured device power, independent of the model.
//
// Method: pull every cached activity with both power and timestamps,
// restrict to "clean" segments (paved surface, early in the run -- low
// cumulative fatigue/impact -- moving, not paused) so the very effects
// Plan B is about to fit don't contaminate the baseline it's fit against,
// then compare measured gross power/kg to what grossMetabolicPower(Cr(i),
// speed) predicts at the same observed speed and grade. Reports the ratio
// (measured/predicted) binned by grade: flat across bins = shape confirmed
// (the overall level can be off by a constant -- that's just a Stryd-
// vs-Minetti calibration factor, not a shape mismatch); a systematic trend
// with grade = the premise underlying Plan B's whole decomposition needs
// rethinking before any regression is built on top of it.
//
// Surface lookup hits Valhalla's public map-matching endpoint directly
// (no auth needed, same one api/surface.ts proxies) and caches responses
// on disk forever (a route's OSM surface tags don't change run to run) --
// deliberately considerate of a shared public service: one request per
// activity, ever, plus a small delay between live requests.
//
// Usage:
//   npx tsx scripts/testMinettiPowerShape.ts [--bodyMassKg=70] [--earlyFraction=0.35]
//     [--gradeBinWidth=0.05] [--maxActivities=60]
//
// Needs no live Strava session -- reads only the existing .strava-cache/
// activity-*.json files already on disk from prior sessions' backfills.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { costOfRunning, costOfWalking } from "../src/model/minetti.ts";
import { grossMetabolicPower } from "../src/model/energetics.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "70"));
const EARLY_FRACTION = parseFloat(arg("earlyFraction", "0.35"));
const GRADE_BIN_WIDTH = parseFloat(arg("gradeBinWidth", "0.05"));
const MAX_ACTIVITIES = parseInt(arg("maxActivities", "60"), 10);
const WALK_MAX_MS = 2.0;
const GRADE_CLAMP = 0.45;

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const VALHALLA_URL = "https://valhalla1.openstreetmap.de/trace_attributes";
const MAX_SHAPE_POINTS = 800;

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { id: string; name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  const id = path.match(/activity-([^/]+)\.json$/)?.[1] ?? path;
  return {
    id,
    name: raw.name,
    points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })),
  };
}

function downsample(points: GpxPoint[], maxPoints: number): { lat: number; lon: number }[] {
  const step = points.length <= maxPoints ? 1 : points.length / maxPoints;
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i * step < points.length; i++) {
    const p = points[Math.floor(i * step)];
    out.push({ lat: p.lat, lon: p.lon });
  }
  return out;
}

async function fetchSurfaceEdgesCached(activityId: string, points: GpxPoint[]): Promise<ValhallaSurfaceEdge[] | null> {
  if (!existsSync(SURFACE_CACHE_DIR)) mkdirSync(SURFACE_CACHE_DIR, { recursive: true });
  const cachePath = `${SURFACE_CACHE_DIR}${activityId}.json`;
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf8")) as ValhallaSurfaceEdge[];
  }
  if (points.length < 2) return null;
  const shape = downsample(points, MAX_SHAPE_POINTS);
  try {
    const res = await fetch(VALHALLA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shape,
        costing: "pedestrian",
        shape_match: "map_snap",
        filters: { attributes: ["edge.surface", "edge.length"], action: "include" },
      }),
    });
    if (!res.ok) {
      console.log(`  surface lookup failed (${res.status}) for ${activityId}`);
      return null;
    }
    const body = (await res.json()) as { edges?: ValhallaSurfaceEdge[] };
    const edges = body.edges ?? [];
    writeFileSync(cachePath, JSON.stringify(edges));
    return edges;
  } catch (err) {
    console.log(`  surface lookup errored for ${activityId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CleanPoint {
  gradient: number;
  measuredGrossPowerWPerKg: number;
  predictedGrossPowerWPerKg: number;
  ratio: number;
  speedMs: number;
  isWalk: boolean;
}

async function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  console.log(`Found ${files.length} cached activities in .strava-cache/.\n`);

  let usedActivities = 0;
  let skippedNoPowerOrTime = 0;
  let skippedNoSurface = 0;
  const points: CleanPoint[] = [];
  let totalSegments = 0;
  let afterCleanFilter = 0;

  for (const file of files) {
    if (usedActivities >= MAX_ACTIVITIES) break;
    const { id, name, points: gpxPoints } = loadCachedActivity(`${CACHE_DIR}${file}`);
    const hasPower = gpxPoints.some((p) => p.power !== null);
    const hasTime = gpxPoints.some((p) => p.time !== null);
    if (!hasPower || !hasTime) {
      skippedNoPowerOrTime++;
      continue;
    }

    const course = runPipeline(gpxPoints);
    totalSegments += course.segments.length;

    const edges = await fetchSurfaceEdgesCached(id, gpxPoints);
    await sleep(150); // considerate of the shared public Valhalla instance
    if (!edges || edges.length === 0) {
      skippedNoSurface++;
      continue;
    }
    const withSurface = attachSurfaceData(course.segments, edges);

    const totalElapsedS = withSurface.reduce((sum, s) => sum + (s.dtS ?? 0), 0);
    const earlyCutoffS = totalElapsedS * EARLY_FRACTION;

    let elapsedS = 0;
    for (const seg of withSurface) {
      const dt = seg.dtS;
      const stillEarly = elapsedS <= earlyCutoffS;
      if (dt !== null && dt > 0) elapsedS += dt;

      if (
        seg.paused ||
        dt === null ||
        dt <= 0 ||
        seg.powerWatts === null ||
        seg.surfaceUnpaved !== false || // strictly known-paved; undefined/true both excluded
        !stillEarly ||
        Math.abs(seg.gradient) > GRADE_CLAMP
      ) {
        continue;
      }

      const speedMs = seg.distance3D / dt;
      if (speedMs <= 0.3) continue; // effectively stationary, not a real moving pace

      const isWalk = speedMs <= WALK_MAX_MS;
      const cost = isWalk ? costOfWalking(seg.gradient) : costOfRunning(seg.gradient);
      const predicted = grossMetabolicPower(cost, speedMs);
      const measured = seg.powerWatts / BODY_MASS_KG;
      afterCleanFilter++;
      points.push({ gradient: seg.gradient, measuredGrossPowerWPerKg: measured, predictedGrossPowerWPerKg: predicted, ratio: measured / predicted, speedMs, isWalk });
    }

    usedActivities++;
    console.log(`  [${usedActivities}/${Math.min(MAX_ACTIVITIES, files.length)}] ${name} -- ${withSurface.length} segments`);
  }

  console.log(
    `\nActivities used: ${usedActivities} (skipped ${skippedNoPowerOrTime} without power+time, ${skippedNoSurface} without surface data)`,
  );
  console.log(`Total pipeline segments seen: ${totalSegments}; clean (paved, early, moving, powered) segments: ${afterCleanFilter}`);

  if (points.length < 20) {
    console.log("\nToo few clean segments to say anything -- widen --earlyFraction, raise --maxActivities, or check surface-lookup failures above.");
    return;
  }

  // Bin by gradient.
  const bins = new Map<number, CleanPoint[]>();
  for (const p of points) {
    const binCenter = Math.round(p.gradient / GRADE_BIN_WIDTH) * GRADE_BIN_WIDTH;
    if (!bins.has(binCenter)) bins.set(binCenter, []);
    bins.get(binCenter)!.push(p);
  }

  const sortedBins = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  console.log("\ngrade    n    measured W/kg   predicted W/kg   ratio     walk%");
  for (const [grade, pts] of sortedBins) {
    if (pts.length < 3) continue;
    const meanMeasured = pts.reduce((s, p) => s + p.measuredGrossPowerWPerKg, 0) / pts.length;
    const meanPredicted = pts.reduce((s, p) => s + p.predictedGrossPowerWPerKg, 0) / pts.length;
    const ratios = pts.map((p) => p.ratio).sort((a, b) => a - b);
    const medianRatio = ratios[Math.floor(ratios.length / 2)];
    const walkPct = (100 * pts.filter((p) => p.isWalk).length) / pts.length;
    console.log(
      `${(grade * 100).toFixed(1).padStart(6)}%  ${String(pts.length).padStart(4)}   ${meanMeasured.toFixed(2).padStart(6)}         ${meanPredicted.toFixed(2).padStart(6)}         ${medianRatio.toFixed(3)}   ${walkPct.toFixed(0).padStart(4)}%`,
    );
  }

  const allRatios = points.map((p) => p.ratio).sort((a, b) => a - b);
  const overallMedianRatio = allRatios[Math.floor(allRatios.length / 2)];

  // Simple linear regression of ratio on gradient -- a real shape mismatch
  // shows up as a nonzero slope (ratio systematically rising or falling
  // with grade), not just noise around a flat line.
  const n = points.length;
  const meanGrade = points.reduce((s, p) => s + p.gradient, 0) / n;
  const meanRatio = points.reduce((s, p) => s + p.ratio, 0) / n;
  let cov = 0;
  let varGrade = 0;
  for (const p of points) {
    cov += (p.gradient - meanGrade) * (p.ratio - meanRatio);
    varGrade += (p.gradient - meanGrade) ** 2;
  }
  const slope = varGrade > 0 ? cov / varGrade : 0;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const predictedRatio = meanRatio + slope * (p.gradient - meanGrade);
    ssRes += (p.ratio - predictedRatio) ** 2;
    ssTot += (p.ratio - meanRatio) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  console.log(`\nOverall median ratio (measured/predicted): ${overallMedianRatio.toFixed(3)}`);
  console.log(`  -- this is a calibration constant (Stryd units vs. Minetti/kg, bodyMassKg=${BODY_MASS_KG} assumed), not itself evidence of a shape mismatch.`);
  console.log(`Ratio-vs-grade slope: ${slope.toFixed(3)} per 100% grade, R²=${r2.toFixed(3)} (n=${n})`);
  console.log(
    slope > 0
      ? "  -- ratio rises with grade -- device power reads relatively HIGHER than Minetti predicts on steeper/uphill segments."
      : "  -- ratio falls with grade -- device power reads relatively LOWER than Minetti predicts on steeper/uphill segments.",
  );
  console.log(
    "\nGate read: a roughly flat ratio across grade bins (small |slope|, low R²) means the shape holds --" +
      " Plan B's premise (power minus a few explicit slowdown factors explains pace) is workable. A strong," +
      " systematic trend means the Minetti shape itself doesn't match this athlete's real device power," +
      " and Plan B's regression needs to account for that mismatch directly rather than assuming it away.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
