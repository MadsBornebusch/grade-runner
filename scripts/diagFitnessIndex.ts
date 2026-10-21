// PLAN.md §15 build stage 2, the go/no-go gate: is the per-run fitness index
// (src/plan/fitnessIndex.ts, power at a reference HR) quiet enough to track
// training effects of 4-10%? Runs it over every cached run with HR, twice:
// with pace-derived power (Minetti, what the app has for any GPS run) and
// with the device's measured power (Stryd-style, where recorded).
//
//   npx tsx scripts/diagFitnessIndex.ts [--bodyMassKg=] [--minMovingMin=30]
//
// Reports:
//   - noise: each run's index against the median of the *other* runs within
//     +-14 days (robust SD, %), and the spread between runs <= 3 days apart
//     (SD of the % difference / sqrt 2), both well below 4-10% to pass;
//   - confounds: rank correlation of that residual with climb per km, mean
//     HR (distance from the reference), duration and summer months (heat);
//   - signal: monthly medians, and the index's +-14-day median against
//     the VO2max read off hard 20-90 min efforts (vo2MaxEstimate.ts);
//   - a data check: runs whose points-based mechanical load is > 1.5x the
//     summary estimate (elevation noise inflating the hill surcharge).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { buildEffortTrendPoints, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { estimateVo2MaxFromRun } from "../src/model/vo2MaxEstimate.ts";
import { runningImpact } from "../src/model/runningImpact.ts";
import { activityLoadFromSummary, localDateKey } from "../src/plan/loadLedger.ts";
import {
  powerAtReferenceHr, pooledPowerPerBpm, pooledPowerPerBpmFromHrOnPower, summarizeRunSamples, type RunHrPowerSummary,
} from "../src/plan/fitnessIndex.ts";
import { arg } from "./stravaScriptHelpers.ts";
import { athleteCeilingParams, loadAthleteProfile } from "./athleteProfile.ts";
import { pearson, rank } from "./powerRunHelpers.ts";
import { solveLinearSystem } from "../src/model/linearSolve.ts";
import { costOfRunning } from "../src/model/minetti.ts";
import { netToGross } from "../src/model/energetics.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const BODY_MASS = Number(arg("bodyMassKg", String(loadAthleteProfile().form.bodyMassKg)));
const MIN_MOVING_MIN = Number(arg("minMovingMin", "30"));
/** Keep only samples whose trailing FLAT_WINDOW_S of terrain stayed within
 * +-FLAT_MAX_GRADE (0 = no terrain filter). */
const FLAT_MAX_GRADE = Number(arg("flatMaxGrade", "0"));
const FLAT_WINDOW_S = Number(arg("flatWindowS", "120"));
const MIN_SAMPLE_MIN = Number(arg("minSampleMin", "15"));
const ceilingParams = athleteCeilingParams();

interface Activity { stravaId: number; name: string; date: string; distanceKm: number; durationS: number; elevationGainM: number }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Activity[];

interface Run {
  id: number; name: string; date: string; day: number; gainPerKm: number; movingMin: number;
  pace: RunHrPowerSummary | null; measured: RunHrPowerSummary | null;
  vo2: number | null; mechRatio: number;
}

const runs: Run[] = [];
for (const a of activities) {
  const path = `${CACHE}activity-${a.stravaId}.json`;
  if (!existsSync(path) || a.durationS < MIN_MOVING_MIN * 60) continue;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { points: (Omit<GpxPoint, "time"> & { time: string | null })[] };
  const points: GpxPoint[] = raw.points.map((p) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  if (points.filter((p) => p.hr).length < 0.8 * points.length) continue;
  const course = runPipeline(points);
  if (!course.hasTimestamps || !course.hasElevation) continue;
  const analysis = analyzeRun(course.segments, { bodyMassKg: BODY_MASS, ceilingParams, fueling: { intakeGPerH: 0 }, glycogenStoreG: 1e9 });
  const trend = buildEffortTrendPoints(course.segments, analysis.segments, true);
  const trendSegments = analysis.segments.filter((s) => s.effortFraction !== null).map((s) => course.segments[s.index]);
  // Trailing max |grade| over FLAT_WINDOW_S, so HR isn't still settling
  // from a climb that just ended.
  const flat = trend.map((p, i) => {
    if (!(FLAT_MAX_GRADE > 0)) return true;
    for (let j = i; j >= 0 && (p.tHours - trend[j].tHours) * 3600 <= FLAT_WINDOW_S; j--) {
      if (Math.abs(trendSegments[j]?.gradient ?? 0) > FLAT_MAX_GRADE) return false;
    }
    return true;
  });
  const measuredIdx: number[] = [];
  const measuredPoints: EffortTrendPoint[] = trend.flatMap((p, i) => {
    const w = trendSegments[i]?.powerWatts;
    if (!w) return [];
    measuredIdx.push(i);
    return [{ ...p, grossPowerWPerKg: w / BODY_MASS }];
  });
  const summaryMech = activityLoadFromSummary({
    activityId: "", date: "", distanceKm: a.distanceKm, elevationGainM: a.elevationGainM ?? 0, movingS: a.durationS, thresholdGrossPowerWPerKg: 15,
  }).mechanical;
  const date = localDateKey(new Date(a.date), "Europe/Oslo");
  runs.push({
    id: a.stravaId, name: a.name, date, day: Date.parse(`${date}T00:00:00Z`) / 864e5,
    gainPerKm: (a.elevationGainM ?? 0) / Math.max(a.distanceKm, 0.1), movingMin: a.durationS / 60,
    pace: summarizeRunSamples(trend, (i) => flat[i], MIN_SAMPLE_MIN),
    measured: measuredPoints.length > 0.8 * trend.length ? summarizeRunSamples(measuredPoints, (k) => flat[measuredIdx[k]], MIN_SAMPLE_MIN) : null,
    vo2: estimateVo2MaxFromRun(analysis, ceilingParams),
    mechRatio: summaryMech > 0 ? runningImpact(course.segments) / summaryMech : 1,
  });
}
runs.sort((a, b) => a.day - b.day);
console.log(`${runs.length} runs with points, HR and >= ${MIN_MOVING_MIN} min (${runs[0]?.date} to ${runs.at(-1)?.date})`);

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const robustSd = (xs: number[]) => { const m = median(xs); return 1.4826 * median(xs.map((x) => Math.abs(x - m))); };
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));

/** Each run's % residual against the median of the *other* runs within
 * +-14 days (null with fewer than 3 neighbours). */
function localResiduals(have: Run[], index: number[]): (number | null)[] {
  return have.map((r, i) => {
    const near = have.map((o, j) => (j !== i && Math.abs(o.day - r.day) <= 14 ? index[j] : null)).filter((x): x is number => x !== null);
    return near.length >= 3 ? (100 * (index[i] - median(near))) / median(near) : null;
  });
}

/** Deterministic PRNG so split-half results are reproducible. */
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

function reportNoise(label: string, have: Run[], index: number[], summaries: RunHrPowerSummary[], refHr: number, scored: (r: Run) => boolean): void {
  const resid = localResiduals(have, index);
  const ok = have.map((_, i) => i).filter((i) => resid[i] !== null && scored(have[i]));
  const rs = ok.map((i) => resid[i]!);
  const pairs: number[] = [];
  for (let i = 0; i < have.length; i++) {
    for (let j = i + 1; j < have.length && have[j].day - have[i].day <= 3; j++) {
      if (scored(have[i]) && scored(have[j])) pairs.push((200 * (index[j] - index[i])) / (index[j] + index[i]));
    }
  }
  const corr = (f: (run: Run, s: RunHrPowerSummary) => number) => spearman(ok.map((i) => f(have[i], summaries[i])), rs).toFixed(2);
  console.log(`  ${label}: vs +-14 d median robust SD ${robustSd(rs).toFixed(1)}% (n=${rs.length}); runs <= 3 d apart per-run SD ${(robustSd(pairs) / Math.SQRT2).toFixed(1)}% (n=${pairs.length} pairs)`);
  console.log(`    residual rank corr: climb/km ${corr((x) => x.gainPerKm)}, duration ${corr((x) => x.movingMin)}, meanHr ${corr((_, s) => s.meanHr)}`);

  // Block level: 28-day blocks, random halves, SD(meanA - meanB) / 2 is the
  // SD of one block mean (in %, against the block's mean).
  const rand = mulberry32(1);
  const blockSds: number[] = [];
  const counts: number[] = [];
  const first = have.find(scored)?.day ?? 0;
  for (let start = first; start <= (have.at(-1)?.day ?? 0); start += 28) {
    const idx = have.map((r, k) => (scored(r) && r.day >= start && r.day < start + 28 ? k : -1)).filter((k) => k >= 0);
    counts.push(idx.length);
    if (idx.length < 4) continue;
    const m = idx.reduce((s, k) => s + index[k], 0) / idx.length;
    let sq = 0;
    const reps = 200;
    for (let rep = 0; rep < reps; rep++) {
      const shuffled = [...idx].sort(() => rand() - 0.5);
      const a = shuffled.slice(0, idx.length >> 1), b = shuffled.slice(idx.length >> 1);
      const d = (a.reduce((s, k) => s + index[k], 0) / a.length - b.reduce((s, k) => s + index[k], 0) / b.length) / m;
      sq += d * d;
    }
    blockSds.push((100 * Math.sqrt(sq / reps)) / 2);
  }
  console.log(`    28-day blocks: qualifying runs per block ${counts.join(",")}; block-mean SD median ${median(blockSds).toFixed(1)}% over ${blockSds.length} blocks with >= 4 runs, so block-to-block difference SD ~${(Math.SQRT2 * median(blockSds)).toFixed(1)}%`);
}

/** Covariates the index is corrected for: climb per km, log duration and
 * distance of the run's mean HR from the reference. */
function covariates(r: Run, s: RunHrPowerSummary, refHr: number): number[] {
  return [r.gainPerKm, Math.log(r.movingMin), s.meanHr - refHr];
}

/** Coefficients fitted on log(index) residuals against the +-14-day median
 * (variation *within* a month, so slow fitness change isn't absorbed), on
 * training runs only. Applied with each covariate clamped to the range it
 * was fitted on, so a steeper run than any in training isn't extrapolated. */
function adjustForCovariates(have: Run[], index: number[], summaries: RunHrPowerSummary[], refHr: number, train: (r: Run) => boolean) {
  const resid = localResiduals(have, index);
  const X = have.map((r, i) => covariates(r, summaries[i], refHr));
  const trainIdx = have.map((_, i) => i).filter((i) => train(have[i]) && resid[i] !== null && Math.abs(Math.log(1 + resid[i]! / 100)) <= 0.4);
  const k = X[0].length;
  const lo = X[0].map((_, q) => Math.min(...trainIdx.map((i) => X[i][q])));
  const hi = X[0].map((_, q) => Math.max(...trainIdx.map((i) => X[i][q])));
  const mean = X[0].map((_, q) => trainIdx.reduce((s, i) => s + X[i][q], 0) / trainIdx.length);
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (const i of trainIdx) {
    const y = Math.log(1 + resid[i]! / 100);
    const x = X[i].map((v, q) => v - mean[q]);
    for (let p = 0; p < k; p++) { b[p] += x[p] * y; for (let q = 0; q < k; q++) A[p][q] += x[p] * x[q]; }
  }
  const beta = solveLinearSystem(A, b);
  if (!beta) return null;
  const adjusted = index.map((v, i) => v * Math.exp(-X[i].reduce((s, x, q) => s + beta[q] * (Math.min(hi[q], Math.max(lo[q], x)) - mean[q]), 0)));
  return { beta, adjusted, lo, hi, nTrain: trainIdx.length };
}

const TRAIN_UNTIL = arg("trainUntil", "2025-12-31");
/** pooled | inverse | lab | a fixed number (W/kg per bpm). "lab" fits
 * flat Minetti power on HR across athlete.local.json's lab stages, for the
 * pace variant. */
const SLOPE_MODE = arg("slopeMode", "pooled");
function labSlope(): number {
  const pts = loadAthleteProfile().labStages.map((st) => ({ hr: st.heartRateBpm, p: netToGross(costOfRunning(0) * (st.speedKmh / 3.6)) }));
  if (pts.length < 2) throw new Error("--slopeMode=lab needs labTest.stages in athlete.local.json");
  const mh = pts.reduce((a, x) => a + x.hr, 0) / pts.length;
  const mp = pts.reduce((a, x) => a + x.p, 0) / pts.length;
  return pts.reduce((a, x) => a + (x.hr - mh) * (x.p - mp), 0) / pts.reduce((a, x) => a + (x.hr - mh) ** 2, 0);
}
const isTrain = (r: Run) => r.date <= TRAIN_UNTIL;
const isTest = (r: Run) => r.date > TRAIN_UNTIL;
const usable = runs.filter((r) => r.mechRatio <= 1.5);
console.log(`Excluding ${runs.length - usable.length} runs with points-based mechanical > 1.5x the summary (bad elevation). Betas fitted on runs <= ${TRAIN_UNTIL}, noise scored on later runs.`);

const RACES = [/askerspurten/i, /oslo trail challenge/i, /saksumdal/i];

for (const variant of ["pace", "measured"] as const) {
  const all = usable.filter((r) => r[variant]);
  const allSummaries = all.map((r) => r[variant]!);
  const pooled = pooledPowerPerBpm(allSummaries);
  const inverse = pooledPowerPerBpmFromHrOnPower(allSummaries);
  if (!pooled || !inverse || all.length < 10) { console.log(`\n[${variant}] too few runs (${all.length})`); continue; }
  const slope = SLOPE_MODE === "pooled" ? pooled : SLOPE_MODE === "inverse" ? inverse : SLOPE_MODE === "lab" ? labSlope() : Number(SLOPE_MODE);
  const refHr = Math.round(median(allSummaries.map((s) => s.meanHr)));
  const raw = allSummaries.map((s) => powerAtReferenceHr(s, slope, refHr));
  const keep = raw.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  console.log(`\n  (${all.length - keep.length} runs dropped: mean HR more than 15 bpm from the reference)`);
  const have = keep.map((i) => all[i]);
  const summaries = keep.map((i) => allSummaries[i]);
  const index = keep.map((i) => raw[i]!);
  console.log(`\n[${variant} power] ${have.length} runs (${have.filter(isTest).length} test), slope ${slope.toFixed(4)} per bpm (power-on-HR ${pooled.toFixed(4)}, HR-on-power inverted ${inverse.toFixed(4)}), reference HR ${refHr}`);
  reportNoise("raw, test runs", have, index, summaries, refHr, isTest);
  const adj = adjustForCovariates(have, index, summaries, refHr, isTrain);
  if (!adj) continue;
  console.log(`  covariates fitted on ${adj.nTrain} training runs: climb/km ${adj.beta[0].toFixed(4)} [${adj.lo[0].toFixed(0)}-${adj.hi[0].toFixed(0)}], log duration ${adj.beta[1].toFixed(3)}, meanHr-ref ${adj.beta[2].toFixed(4)}`);
  reportNoise("adjusted, test runs", have, adj.adjusted, summaries, refHr, isTest);
  const final = adj.adjusted;

  const byMonth = new Map<string, number[]>();
  have.forEach((x, i) => { const m = x.date.slice(0, 7); byMonth.set(m, [...(byMonth.get(m) ?? []), final[i]]); });
  console.log("  monthly median index (n): " + [...byMonth].filter(([m]) => m >= "2024").map(([m, xs]) => `${m} ${median(xs).toFixed(2)}(${xs.length})`).join("  "));
  const oct25 = have.map((x, i) => ({ x, i })).filter(({ x }) => x.date.startsWith("2025-10"));
  console.log("  Oct 2025 runs: " + oct25.map(({ x, i }) => `${x.date} ${x.gainPerKm.toFixed(0)} m/km raw ${index[i].toFixed(2)} adj ${final[i].toFixed(2)}`).join("; "));

  // Validity: same-course races, race-time ratio against the ratio of the
  // index's mean over the 6 weeks before each.
  for (const re of RACES) {
    const instances = activities.filter((a) => re.test(a.name)).map((a) => ({ a, day: Date.parse(a.date) / 864e5 }));
    if (instances.length < 2) continue;
    const pre = instances.map(({ day }) => {
      const xs = have.map((r, i) => (r.day < day && r.day >= day - 42 ? final[i] : NaN)).filter((v) => !Number.isNaN(v));
      return { mean: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN, n: xs.length };
    });
    console.log(`  ${re.source}: ` + instances.map(({ a }, k) => `${a.date.slice(0, 10)} ${(a.durationS / 60).toFixed(1)} min ${a.distanceKm.toFixed(1)} km, index 6 wk before ${pre[k].mean.toFixed(2)} (n=${pre[k].n})`).join(" | "));
  }
}

const suspicious = runs.filter((r) => r.mechRatio > 1.5);
console.log(`\nRuns with points-based mechanical > 1.5x the summary estimate: ${suspicious.length} of ${runs.length}`);
for (const r of suspicious) console.log(`  ${r.date} ${r.name.slice(0, 32).padEnd(33)} x${r.mechRatio.toFixed(2)}  ${r.gainPerKm.toFixed(0)} m/km by summary`);
