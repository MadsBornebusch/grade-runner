// PLAN.md §15 build stage 2, durability v2: the same descent run at
// different times into different runs (src/plan/durabilityIndex.ts's
// fitTileFade). Pass bar fixed in PLAN.md before running this.
//
//   npx tsx scripts/diagDurabilityTiles.ts [--reps=100] [--blockDays=84]
//
// Reports the pooled descent and flat slopes (log speed per hour into the
// run) with a bootstrap over runs, their difference, the dose cap's
// sensitivity, and per-block descent slopes with their SE.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { runningImpact } from "../src/model/runningImpact.ts";
import { activityLoadFromSummary, localDateKey } from "../src/plan/loadLedger.ts";
import {
  DESCENT_PASSAGE_GRADE, FLAT_PASSAGE_GRADE, fitTileFade, runPassages, type FadeObservation, type Passage,
} from "../src/plan/durabilityIndex.ts";
import { arg } from "./stravaScriptHelpers.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const REPS = Number(arg("reps", "100"));
const BLOCK_DAYS = Number(arg("blockDays", "84"));

interface Activity { stravaId: number; name: string; date: string; distanceKm: number; durationS: number; elevationGainM: number }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Activity[];

interface Run { id: string; date: string; hours: number; descent: Passage[]; flat: Passage[] }
const runs: Run[] = [];
for (const a of activities) {
  const path = `${CACHE}activity-${a.stravaId}.json`;
  if (!existsSync(path) || a.durationS < 20 * 60) continue;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { points: (Omit<GpxPoint, "time"> & { time: string | null })[] };
  const course = runPipeline(raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null })));
  if (!course.hasTimestamps || !course.hasElevation) continue;
  const summaryMech = activityLoadFromSummary({
    activityId: "", date: "", distanceKm: a.distanceKm, elevationGainM: a.elevationGainM ?? 0, movingS: a.durationS, thresholdGrossPowerWPerKg: 15,
  }).mechanical;
  if (summaryMech > 0 && runningImpact(course.segments) / summaryMech > 1.5) continue;
  runs.push({
    id: String(a.stravaId), date: localDateKey(new Date(a.date), "Europe/Oslo"), hours: a.durationS / 3600,
    descent: runPassages(course.segments, course.routePoints, { grade: DESCENT_PASSAGE_GRADE }),
    flat: runPassages(course.segments, course.routePoints, { grade: FLAT_PASSAGE_GRADE, runningOnly: true }),
  });
}
runs.sort((a, b) => a.date.localeCompare(b.date));
console.log(`${runs.length} runs, ${runs.reduce((s, r) => s + r.descent.length, 0)} descent and ${runs.reduce((s, r) => s + r.flat.length, 0)} flat passages`);

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(1);

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const firstDay = day(runs[0].date);
const blockOf = (r: Run) => {
  const start = firstDay + BLOCK_DAYS * Math.floor((day(r.date) - firstDay) / BLOCK_DAYS);
  return new Date(start * 864e5).toISOString().slice(0, 10);
};

function observations(rs: Run[], kind: "descent" | "flat", group: (r: Run) => string, tag = ""): FadeObservation[] {
  return rs.flatMap((r, k) => r[kind].map((p) => ({ ...p, run: `${r.id}${tag && `#${k}`}`, group: group(r) })));
}

/** Point fit plus a bootstrap over runs (resampled with replacement, each
 * copy its own run). */
function fitWithSe(kind: "descent" | "flat", group: (r: Run) => string, maxHours: number) {
  const point = fitTileFade(observations(runs, kind, group), { maxHours });
  const boots = new Map<string, number[]>();
  for (let rep = 0; rep < REPS; rep++) {
    const sample = runs.map(() => runs[Math.floor(rand() * runs.length)]);
    for (const [g, b] of fitTileFade(observations(sample, kind, group, "boot"), { maxHours })) {
      (boots.get(g) ?? boots.set(g, []).get(g)!).push(b);
    }
  }
  const se = new Map([...boots].map(([g, bs]) => {
    const m = bs.reduce((s, x) => s + x, 0) / bs.length;
    return [g, Math.sqrt(bs.reduce((s, x) => s + (x - m) ** 2, 0) / (bs.length - 1))];
  }));
  return { point, se, boots };
}

const pctH = (x: number | undefined) => (x === undefined ? "-" : `${(100 * x).toFixed(2)}%/h`);

console.log("\npooled slopes (log speed per hour into the run), bootstrap SE over runs:");
for (const maxHours of [3, 5, 24]) {
  const d = fitWithSe("descent", () => "all", maxHours);
  const f = fitWithSe("flat", () => "all", maxHours);
  // Paired difference: same resampled runs aren't shared between the two
  // calls, so the SE of the difference is from independent bootstraps.
  const diff = d.point.get("all")! - f.point.get("all")!;
  const seDiff = Math.hypot(d.se.get("all")!, f.se.get("all")!);
  console.log(`  dose <= ${String(maxHours).padStart(2)} h: descent ${pctH(d.point.get("all"))} ± ${pctH(d.se.get("all"))}, flat ${pctH(f.point.get("all"))} ± ${pctH(f.se.get("all"))}, descent - flat ${pctH(diff)} ± ${pctH(seDiff)} (95% ${pctH(diff - 1.96 * seDiff)} .. ${pctH(diff + 1.96 * seDiff)})`);
}

console.log(`\nper ${BLOCK_DAYS}-day block, descent slope (dose <= 5 h), bootstrap SE; runs >= 90 min in block:`);
const blocks = fitWithSe("descent", blockOf, 5);
const flatBlocks = fitWithSe("flat", blockOf, 5);
for (const g of [...new Set(runs.map(blockOf))]) {
  const inBlock = runs.filter((r) => blockOf(r) === g);
  console.log(`  ${g}: descent ${pctH(blocks.point.get(g)).padStart(9)} ± ${pctH(blocks.se.get(g)).padEnd(9)} flat ${pctH(flatBlocks.point.get(g)).padStart(9)} ± ${pctH(flatBlocks.se.get(g)).padEnd(9)} runs ${inBlock.length}, long ${inBlock.filter((r) => r.hours >= 1.5).length}`);
}

console.log("\nper year, descent slope (dose <= 5 h):");
const years = fitWithSe("descent", (r) => r.date.slice(0, 4), 5);
for (const [g, b] of [...years.point].sort()) console.log(`  ${g}: ${pctH(b)} ± ${pctH(years.se.get(g))}`);
