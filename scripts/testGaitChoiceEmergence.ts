// Follow-up to PLAN.md §14 Stage 0 / §6: "should we add walk modeling --
// find grades where the athlete always walks and force Minetti walk cost
// there instead?" The mechanism already exists (`forceWalkAboveGrade` in
// solver.ts/FormInputs, default off) as exactly the manual override §6
// already recommended; the real question is whether the EXISTING emergent
// choice (argmax of v_run/v_walk at equal power, see §6) already reproduces
// this athlete's real gait transition, making a forced override redundant.
//
// Three independent checks, none relying on a shaky device-power-to-Minetti
// unit conversion (an earlier version of this script tried exactly that --
// converting Stryd's powerWatts into a "predicted mode" via costOfRunning/
// costOfWalking -- and the resulting agreement% turned out to be near-
// tautological: with the conversion calibrated so that predicted running
// speed matches actual running speed on the flat, "predicted mode" reduces
// almost exactly to the same speed threshold used to define "actual mode".
// Dropped in favor of these three, which don't have that problem):
//
// (A) Ground truth, no model at all: real walk% by grade bin, straight from
//     GPS speed (same speed-threshold gait proxy analysis.ts/solver.ts
//     already use everywhere -- GPS has no gait sensor). Directly answers
//     "at what grade does this athlete always walk."
// (B) Analytical, no device power at all: at a handful of representative
//     sustainable net-power levels, compute the actual crossover grade
//     where solver.ts's own emergent argmax(v_run, v_walk) formula already
//     switches to walk. If that crossover sits at or below where (A) shows
//     "always walks", the existing mechanism already explains it and a
//     forced override adds nothing.
// (C) Real, not derived from power: for actually-running descending
//     segments (speed > walkMaxMs), compare their real GPS speed against
//     `maxDescentSpeedMs(grade)` -- checks whether that cap (a single
//     noisy 55km-ultra calibration point per its own doc comment) is
//     actually consistent with how fast this athlete runs downhill.
//
// No network calls -- reads the existing .strava-cache/ activities on disk.
//
// Usage:
//   npx tsx scripts/testGaitChoiceEmergence.ts [--maxActivities=250] [--walkMaxMs=2.0]

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { costOfRunning, costOfWalking, maxDescentSpeedMs } from "../src/model/minetti.ts";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { arg } from "./stravaScriptHelpers.ts";

const MAX_ACTIVITIES = parseInt(arg("maxActivities", "250"), 10);
const WALK_MAX_MS = parseFloat(arg("walkMaxMs", "2.0"));
const GRADE_BIN_WIDTH = 0.05;

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));

interface CachedActivityPoints {
  name: string;
  points: Array<Omit<GpxPoint, "time"> & { time: string | null }>;
}

function loadCachedActivity(path: string): { name: string; points: GpxPoint[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CachedActivityPoints;
  return { name: raw.name, points: raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })) };
}

interface Row {
  gradient: number;
  speedMs: number;
  mode: "run" | "walk";
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("activity-") && f.endsWith(".json"));
  console.log(`Found ${files.length} cached activities.\n`);

  const rows: Row[] = [];
  let usedActivities = 0;

  for (const file of files) {
    if (usedActivities >= MAX_ACTIVITIES) break;
    const { points: gpxPoints } = loadCachedActivity(`${CACHE_DIR}${file}`);
    if (!gpxPoints.some((p) => p.time !== null)) continue;

    const course = runPipeline(gpxPoints);
    for (const seg of course.segments) {
      const dt = seg.dtS;
      if (seg.paused || dt === null || dt <= 0) continue;
      const speedMs = seg.distance3D / dt;
      if (speedMs <= 0.3) continue;
      rows.push({ gradient: seg.gradient, speedMs, mode: speedMs <= WALK_MAX_MS ? "walk" : "run" });
    }
    usedActivities++;
  }
  console.log(`Activities used: ${usedActivities}; segments analyzed: ${rows.length}\n`);

  // (A) Ground truth: real walk% by grade, no model involved.
  const bins = new Map<number, Row[]>();
  for (const r of rows) {
    const binCenter = Math.round(r.gradient / GRADE_BIN_WIDTH) * GRADE_BIN_WIDTH;
    if (!bins.has(binCenter)) bins.set(binCenter, []);
    bins.get(binCenter)!.push(r);
  }
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);

  console.log("(A) Ground truth -- actual walk% by grade (no model)");
  console.log("grade    n      walk%");
  for (const [grade, pts] of sorted) {
    if (pts.length < 5) continue;
    const walkPct = (100 * pts.filter((p) => p.mode === "walk").length) / pts.length;
    console.log(`${(grade * 100).toFixed(1).padStart(6)}%  ${String(pts.length).padStart(6)}   ${walkPct.toFixed(0).padStart(4)}%`);
  }

  // (B) Analytical: crossover grade at representative net-power levels,
  // straight from solver.ts's own emergent formula -- no device power, no
  // calibration, no real data at all, just the model's own math.
  console.log("\n(B) Analytical -- grade at which the emergent model (argmax v_run/v_walk) switches to walk");
  console.log("net power (W/kg)   crossover grade");
  for (const netPowerWPerKg of [6, 8, 10, 12, 15, 18]) {
    let crossoverGrade: number | null = null;
    for (let i = -0.05; i <= 0.5; i += 0.005) {
      const vRun = Math.min(netPowerWPerKg / costOfRunning(i), maxDescentSpeedMs(i));
      const vWalk = Math.min(WALK_MAX_MS, netPowerWPerKg / costOfWalking(i));
      if (vWalk >= vRun) {
        crossoverGrade = i;
        break;
      }
    }
    console.log(`${String(netPowerWPerKg).padStart(14)}   ${crossoverGrade !== null ? `${(crossoverGrade * 100).toFixed(1)}%` : "never (within +50%)"}`);
  }

  // (C) Real, power-independent: does maxDescentSpeedMs actually cap this
  // athlete's real running descent speed, or is it more conservative than
  // their real behavior?
  console.log("\n(C) Descent cap check -- real GPS speed on RUNNING descents vs. maxDescentSpeedMs(grade)");
  console.log("grade    n     median actual speed   cap at this grade   actual/cap");
  for (const [grade, pts] of sorted) {
    if (grade >= -0.05) continue; // only descents where the cap can engage
    const runningPts = pts.filter((p) => p.mode === "run");
    if (runningPts.length < 5) continue;
    const speeds = runningPts.map((p) => p.speedMs).sort((a, b) => a - b);
    const medianSpeed = speeds[Math.floor(speeds.length / 2)];
    const cap = maxDescentSpeedMs(grade);
    console.log(
      `${(grade * 100).toFixed(1).padStart(6)}%  ${String(runningPts.length).padStart(5)}   ${medianSpeed.toFixed(2).padStart(6)} m/s            ${cap === Infinity ? "inf" : cap.toFixed(2)} m/s          ${cap === Infinity ? "--" : (medianSpeed / cap).toFixed(2)}`,
    );
  }
}

main();
