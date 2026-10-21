// PLAN.md §15 build stage 2, durability half: is the late-descent fade
// (src/plan/durabilityIndex.ts) a usable per-athlete durability reading?
// Pass bar fixed in PLAN.md before running this.
//
//   npx tsx scripts/diagDurabilityIndex.ts [--minMovingMin=90] [--trainUntil=2025-12-31]
//
// Reports, for every cached run with points and >= minMovingMin moving:
//   - descent fade (late third vs early third), flat fade, and their
//     difference, per run with a block-bootstrap SE;
//   - two placebos: middle third vs early third (half the dose), and an
//     interleaved split (alternate 10 min blocks, no dose at all);
//   - dose-response on runs up to trainUntil: rank correlation with
//     duration and early descent;
//   - resolution on later runs: duration-adjusted fade (fitted on the
//     training runs), its 12-week block means and their SE.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { descentMeters } from "../src/model/descentImpact.ts";
import { runningImpact } from "../src/model/runningImpact.ts";
import { activityLoadFromSummary, localDateKey } from "../src/plan/loadLedger.ts";
import { descentFade, flatFade, movingWindow, paceSamples, type PaceSample } from "../src/plan/durabilityIndex.ts";
import { arg } from "./stravaScriptHelpers.ts";
import { pearson, rank, partial } from "./powerRunHelpers.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const MIN_MOVING_MIN = Number(arg("minMovingMin", "90"));
const TRAIN_UNTIL = arg("trainUntil", "2025-12-31");
const BOOTSTRAP_BLOCK_S = 300;
const BOOTSTRAP_REPS = 200;

interface Activity { stravaId: number; name: string; date: string; distanceKm: number; durationS: number; elevationGainM: number }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Activity[];

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(1);

/** Resample a window's samples in BOOTSTRAP_BLOCK_S blocks, with
 * replacement, keeping the block count. */
function resampleBlocks(xs: PaceSample[]): PaceSample[] {
  if (!xs.length) return xs;
  const blocks: PaceSample[][] = [];
  for (const s of xs) {
    const k = Math.floor((s.tS - xs[0].tS) / BOOTSTRAP_BLOCK_S);
    (blocks[k] ??= []).push(s);
  }
  const full = blocks.filter(Boolean);
  return full.flatMap(() => full[Math.floor(rand() * full.length)]);
}

interface Row {
  id: number; name: string; date: string; train: boolean; hours: number; descentPerKm: number; earlyDescentM: number;
  fade: number; se: number | null; flat: number | null; halfDose: number | null; interleaved: number | null; bands: string;
}
const rows: Row[] = [];
let skippedNoDescent = 0;
let skippedBadElevation = 0;
for (const a of activities) {
  const path = `${CACHE}activity-${a.stravaId}.json`;
  if (!existsSync(path) || a.durationS < MIN_MOVING_MIN * 60) continue;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { points: (Omit<GpxPoint, "time"> & { time: string | null })[] };
  const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(points);
  if (!course.hasTimestamps || !course.hasElevation) continue;
  const summaryMech = activityLoadFromSummary({
    activityId: "", date: "", distanceKm: a.distanceKm, elevationGainM: a.elevationGainM ?? 0, movingS: a.durationS, thresholdGrossPowerWPerKg: 15,
  }).mechanical;
  if (summaryMech > 0 && runningImpact(course.segments) / summaryMech > 1.5) { skippedBadElevation++; continue; }

  const samples = paceSamples(course.segments);
  if ((samples.at(-1)?.tS ?? 0) < MIN_MOVING_MIN * 60) continue;
  const early = movingWindow(samples, 0, 1 / 3);
  const mid = movingWindow(samples, 1 / 3, 2 / 3);
  const late = movingWindow(samples, 2 / 3, 1);
  const main = descentFade(early, late);
  if (main.logFade === null) { skippedNoDescent++; continue; }

  const boots: number[] = [];
  for (let r = 0; r < BOOTSTRAP_REPS; r++) {
    const f = descentFade(resampleBlocks(early), resampleBlocks(late)).logFade;
    if (f !== null) boots.push(f);
  }
  const bm = boots.reduce((s, x) => s + x, 0) / boots.length;
  const se = boots.length > 20 ? Math.sqrt(boots.reduce((s, x) => s + (x - bm) ** 2, 0) / (boots.length - 1)) : null;

  // Interleaved placebo over the same post-warm-up span: alternate 10 min
  // blocks into A and B, so both halves see the same mix of fresh and tired.
  const whole = movingWindow(samples, 0, 1);
  const blockOf = (s: PaceSample) => Math.floor((s.tS - (whole[0]?.tS ?? 0)) / 600) % 2;
  const interleaved = descentFade(whole.filter((s) => blockOf(s) === 0), whole.filter((s) => blockOf(s) === 1)).logFade;

  const firstHalfEnd = course.segments.findIndex((s) => s.cumulativeDistance3D >= course.segments.at(-1)!.cumulativeDistance3D / 2);
  const date = localDateKey(new Date(a.date), "Europe/Oslo");
  rows.push({
    id: a.stravaId, name: a.name, date, train: date <= TRAIN_UNTIL, hours: samples.at(-1)!.tS / 3600,
    descentPerKm: descentMeters(course.segments) / Math.max(a.distanceKm, 0.1),
    earlyDescentM: descentMeters(course.segments.slice(0, firstHalfEnd)),
    fade: main.logFade, se, flat: flatFade(early, late), halfDose: descentFade(early, mid).logFade, interleaved,
    bands: main.bands.map((b) => `${Math.round(-100 * b.band[1])}-${Math.round(-100 * b.band[0])}%:${(100 * b.logFade).toFixed(0)}(${Math.round(b.earlyS / 60)}/${Math.round(b.lateS / 60)}m,${(100 * b.earlyGrade).toFixed(0)}/${(100 * b.lateGrade).toFixed(0)})`).join(" "),
  });
}
rows.sort((a, b) => a.date.localeCompare(b.date));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const robustSd = (xs: number[]) => { const m = median(xs); return 1.4826 * median(xs.map((x) => Math.abs(x - m))); };
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));
const pct = (x: number | null) => (x === null ? "   -" : `${(100 * x).toFixed(1).padStart(5)}`);

console.log(`${rows.length} runs >= ${MIN_MOVING_MIN} min with descent in both thirds (${skippedNoDescent} without, ${skippedBadElevation} with bad elevation)`);
console.log("date        h    D/km  fade    se  flat  d-flat half inter  bands (fade%, early/late min, mean grade%)  name");
for (const r of rows) {
  console.log(`${r.date} ${r.hours.toFixed(1).padStart(4)} ${r.descentPerKm.toFixed(0).padStart(4)} ${pct(r.fade)} ${pct(r.se)} ${pct(r.flat)} ${pct(r.flat === null ? null : r.fade - r.flat)} ${pct(r.halfDose)} ${pct(r.interleaved)}  ${r.bands}  ${r.name}`);
}

function summarize(label: string, rs: Row[]): void {
  const withFlat = rs.filter((r) => r.flat !== null);
  const half = rs.filter((r) => r.halfDose !== null);
  const inter = rs.filter((r) => r.interleaved !== null);
  console.log(`\n${label} (n=${rs.length})`);
  console.log(`  descent fade: median ${(100 * median(rs.map((r) => r.fade))).toFixed(1)}%, robust SD ${(100 * robustSd(rs.map((r) => r.fade))).toFixed(1)}; median bootstrap SE ${(100 * median(rs.filter((r) => r.se !== null).map((r) => r.se!))).toFixed(1)}`);
  console.log(`  flat fade: median ${(100 * median(withFlat.map((r) => r.flat!))).toFixed(1)}% (n=${withFlat.length})`);
  console.log(`  placebo half-dose (mid vs early): median ${(100 * median(half.map((r) => r.halfDose!))).toFixed(1)}%, robust SD ${(100 * robustSd(half.map((r) => r.halfDose!))).toFixed(1)} (n=${half.length})`);
  console.log(`  placebo interleaved: median ${(100 * median(inter.map((r) => r.interleaved!))).toFixed(1)}%, robust SD ${(100 * robustSd(inter.map((r) => r.interleaved!))).toFixed(1)} (n=${inter.length})`);
  console.log(`  rank corr of descent fade with: hours ${spearman(rs.map((r) => r.hours), rs.map((r) => r.fade)).toFixed(2)}, early descent m ${spearman(rs.map((r) => r.earlyDescentM), rs.map((r) => r.fade)).toFixed(2)}, descent/km ${spearman(rs.map((r) => r.descentPerKm), rs.map((r) => r.fade)).toFixed(2)}`);
  if (withFlat.length >= 5) {
    const d = withFlat.map((r) => r.fade - r.flat!);
    console.log(`  descent minus flat: median ${(100 * median(d)).toFixed(1)}%, rank corr with hours ${spearman(withFlat.map((r) => r.hours), d).toFixed(2)}; descent vs flat fade rank corr ${spearman(withFlat.map((r) => r.flat!), withFlat.map((r) => r.fade)).toFixed(2)}`);
    console.log(`  descent fade vs early descent, partial on hours: ${partial(rs.map((r) => r.earlyDescentM), rs.map((r) => r.fade), [rs.map((r) => r.hours)]).toFixed(2)}`);
  }
}
const train = rows.filter((r) => r.train);
const test = rows.filter((r) => !r.train);
summarize(`runs up to ${TRAIN_UNTIL}`, train);
summarize("later runs", test);

// Duration adjustment, fitted on the training runs: fade = a + b ln(hours).
const x = train.map((r) => Math.log(r.hours));
const mx = x.reduce((s, v) => s + v, 0) / x.length;
const my = train.reduce((s, r) => s + r.fade, 0) / train.length;
const b = x.reduce((s, v, i) => s + (v - mx) * (train[i].fade - my), 0) / x.reduce((s, v) => s + (v - mx) ** 2, 0);
const a = my - b * mx;
console.log(`\nduration adjustment (training runs): fade = ${(100 * a).toFixed(1)}% + ${(100 * b).toFixed(1)}% x ln(hours)  -> at 2 h ${(100 * (a + b * Math.log(2))).toFixed(1)}%, at 5 h ${(100 * (a + b * Math.log(5))).toFixed(1)}%`);
const adjusted = (r: Row) => r.fade - (a + b * Math.log(r.hours));
for (const [label, rs] of [["training", train], ["later", test]] as const) {
  const adj = rs.map(adjusted);
  console.log(`  ${label}: adjusted fade robust SD ${(100 * robustSd(adj)).toFixed(1)} points, SD ${(100 * Math.sqrt(adj.reduce((s, v) => s + v * v, 0) / adj.length)).toFixed(1)}`);
}

// 12-week blocks on the later runs (and the whole history, for context).
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
for (const [label, rs] of [["later runs", test], ["all runs", rows]] as const) {
  if (!rs.length) continue;
  const parts: string[] = [];
  for (let start = day(rs[0].date); start <= day(rs.at(-1)!.date); start += 84) {
    const blk = rs.filter((r) => day(r.date) >= start && day(r.date) < start + 84);
    if (!blk.length) continue;
    const adj = blk.map(adjusted);
    const m = adj.reduce((s, v) => s + v, 0) / adj.length;
    const sd = adj.length > 1 ? Math.sqrt(adj.reduce((s, v) => s + (v - m) ** 2, 0) / (adj.length - 1)) : NaN;
    parts.push(`${new Date(start * 864e5).toISOString().slice(0, 7)}: ${(100 * m).toFixed(1)}±${(100 * sd / Math.sqrt(adj.length)).toFixed(1)} (n=${adj.length})`);
  }
  console.log(`\n12-week blocks, duration-adjusted fade, mean ± SE, ${label}:\n  ${parts.join("\n  ")}`);
}
