// PLAN.md §15 build stage 3: does a per-athlete responsiveness (elasticity
// of the fitness index to chronic load, src/plan/responseModel.ts) predict
// the next block's index change better than no change or a fixed prior?
// Pass bar fixed in PLAN.md before running this.
//
//   npx tsx scripts/backtestResponseModel.ts [--blockDays=42] [--minReadings=3]
//     [--pairsFrom=YYYY-MM-DD] [--maxReadingMin=]
// The last two are sensitivity checks, not the pre-registered set: drop
// pairs whose later block starts before a date (the chronic EWMA starts at
// zero with the Strava history, so the first months' ramps are partly
// warm-up), and drop readings from runs longer than a duration (one ultra
// in a 3-reading block moves its mean, since the index reads lower on long
// runs).
import { capSpikes, dailySeries, ewma } from "../src/plan/loadLedger.ts";
import { adjacentPairs, blocksOf, posteriorElasticity, walkForward, type BlockPair, type WalkForwardPrediction } from "../src/plan/responseModel.ts";
import { arg } from "./stravaScriptHelpers.ts";
import { fitnessReadings, loadPlanRuns } from "./planRunData.ts";

const BLOCK_DAYS = Number(arg("blockDays", "42"));
const MIN_READINGS = Number(arg("minReadings", "3"));
const PER_READING_SD = 0.049;
const PRIOR = { mean: 0.1, sd: 0.1 };
const HALF_LIFE_DAYS = 75;
const PAIRS_FROM = arg("pairsFrom", "");
const MAX_READING_MIN = Number(arg("maxReadingMin", "Infinity"));

const runs = loadPlanRuns();
const { readings, slope, referenceHr } = fitnessReadings(runs);
console.log(`${runs.length} activities, ${readings.length} index readings (slope ${slope.toFixed(3)} W/kg per bpm, reference HR ${referenceHr})`);

const firstDay = runs[0].day;
const from = runs[0].date;
const to = runs.at(-1)!.date;
const hoursDaily = dailySeries(runs.map((r) => ({ ...r.load, mechanical: r.load.movingS / 3600 })), "mechanical", from, to).map((d) => d.value);
const mechDaily = dailySeries(runs.map((r) => r.load), "mechanical", from, to).map((d) => d.value);
const chronicOf = (daily: number[]) => {
  const c = ewma(capSpikes(daily), 42);
  return (start: number, end: number) => {
    const xs = c.slice(Math.max(0, start - firstDay), Math.max(0, end - firstDay));
    return xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  };
};
const hoursChronic = chronicOf(hoursDaily);
const mechChronic = chronicOf(mechDaily);

const kept = readings.filter((r) => r.run.movingMin <= MAX_READING_MIN);
const reads = kept.map((r) => ({ day: r.run.day, value: r.value }));
const blocks = blocksOf(reads, reads[0].day, reads.at(-1)!.day, BLOCK_DAYS);
const fromDay = PAIRS_FROM ? Date.parse(`${PAIRS_FROM}T00:00:00Z`) / 864e5 : -Infinity;
const hoursPairs = adjacentPairs(blocks, hoursChronic, MIN_READINGS, PER_READING_SD).filter((p) => p.later.start >= fromDay);
const mechPairs = adjacentPairs(blocks, mechChronic, MIN_READINGS, PER_READING_SD).filter((p) => p.later.start >= fromDay);

const iso = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);
const meanDuration = (start: number, end: number) => {
  const xs = kept.filter((r) => r.run.day >= start && r.run.day < end).map((r) => r.run.movingMin);
  return xs.reduce((s, v) => s + v, 0) / xs.length;
};
const pearson = (a: number[], b: number[]) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; });
  return n / Math.sqrt(da * db);
};

console.log(`\n${hoursPairs.length} pairs of ${BLOCK_DAYS}-day blocks with >= ${MIN_READINGS} readings each:`);
console.log("later block   n     hours ramp  mech ramp  index change  d mean duration");
const dDur = hoursPairs.map((p) => meanDuration(p.later.start, p.later.end) - meanDuration(p.earlier.start, p.earlier.end));
hoursPairs.forEach((p, i) => {
  console.log(`${iso(p.later.start)}  ${p.earlier.n}/${p.later.n}  ${(100 * p.ramp).toFixed(0).padStart(8)}%  ${(100 * mechPairs[i].ramp).toFixed(0).padStart(8)}%  ${(100 * p.change).toFixed(1).padStart(10)}%  ${dDur[i].toFixed(0).padStart(8)} min`);
});
const change = hoursPairs.map((p) => p.change);
console.log(`corr with index change: hours ramp ${pearson(hoursPairs.map((p) => p.ramp), change).toFixed(2)}, mech ramp ${pearson(mechPairs.map((p) => p.ramp), change).toFixed(2)}, d mean duration ${pearson(dDur, change).toFixed(2)}`);
console.log(`corr hours ramp vs d mean duration ${pearson(hoursPairs.map((p) => p.ramp), dDur).toFixed(2)}; hours vs mech ramp ${pearson(hoursPairs.map((p) => p.ramp), mechPairs.map((p) => p.ramp)).toFixed(2)}`);
const byMonth = hoursPairs.map((p) => `${iso(p.later.start).slice(5, 7)}:${(100 * p.ramp).toFixed(0)}/${(100 * p.change).toFixed(0)}`);
console.log(`season (month of later block: ramp%/change%): ${byMonth.join(" ")}`);

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

function score(label: string, pairs: BlockPair[]): void {
  const preds = walkForward(pairs, PRIOR, HALF_LIFE_DAYS);
  const rmse = (f: (p: WalkForwardPrediction) => number, ps = preds) => Math.sqrt(ps.reduce((s, p) => s + (p.pair.change - f(p)) ** 2, 0) / ps.length);
  const r0 = rmse((p) => p.noChange), r1 = rmse((p) => p.prior), r2 = rmse((p) => p.fitted);
  const rand = mulberry32(1);
  const gains: number[] = [];
  for (let rep = 0; rep < 4000; rep++) {
    const s = preds.map(() => preds[Math.floor(rand() * preds.length)]);
    gains.push(rmse((p) => p.noChange, s) - rmse((p) => p.fitted, s));
  }
  gains.sort((a, b) => a - b);
  const wins = preds.filter((p) => Math.abs(p.pair.change - p.fitted) < Math.abs(p.pair.change)).length;
  const last = posteriorElasticity(pairs, PRIOR, pairs.at(-1)!.later.end, HALF_LIFE_DAYS);
  const flat = posteriorElasticity(pairs, PRIOR, pairs.at(-1)!.later.end, 1e9);
  console.log(`\n[${label} ramp] walk-forward over ${preds.length} pairs: RMSE no change ${(100 * r0).toFixed(2)}%, prior ${(100 * r1).toFixed(2)}%, fitted ${(100 * r2).toFixed(2)}%`);
  console.log(`  fitted beats no change by ${(100 * (r0 - r2)).toFixed(2)} points (95% bootstrap ${(100 * gains[100]).toFixed(2)} .. ${(100 * gains[3899]).toFixed(2)}); closer than no change on ${wins} of ${preds.length} pairs`);
  console.log(`  elasticity now ${last.mean.toFixed(3)} ± ${last.sd.toFixed(3)} (no time decay: ${flat.mean.toFixed(3)} ± ${flat.sd.toFixed(3)}); path: ${preds.map((p) => p.posterior.mean.toFixed(2)).join(" ")}`);
}
score("hours", hoursPairs);
score("mechanical", mechPairs);
