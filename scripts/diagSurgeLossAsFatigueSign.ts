// Is a LACK of surges on climbs a sign of fatigue? Do surges get rarer or
// smaller as a run goes on -- beyond what terrain, pacing and a general
// drop in power already explain?
//
// The raw fact "surges decline over a run" is near-certain and means
// nothing: routes put their big climbs in particular places, people go out
// hard and settle in, fuel and heat fall. So the design, fixed before
// looking at any result:
//
// - Matched opportunity. Surges are compared within the same gradient band
//   (3-8%, 8-15%, >=15%), early third vs last third, and only where both
//   thirds have real time on that band. A surge needs a climb to happen on.
// - Beyond the mean shift. Late power is lower everywhere, so a fixed
//   threshold loses surges automatically. Two measures remove that:
//     spikiness = p95 of 30 s power / mean power, same band, same third
//     surge frequency = share of band time where 30 s power exceeds 1.2x
//       the trailing 10 min average -- a threshold that moves with the
//       athlete's CURRENT level, not their fresh one.
//   Magnitude (p95 itself) is reported separately: frequency can fall by
//   choice, a falling ceiling is harder to explain that way.
// - Validation. A fatigue sign should (a) grow with run length -- the same
//   loss on a 1.6 h run as on an 8 h race is pacing or terrain -- and (b)
//   track independent fatigue measures taken on DISJOINT data: flat-ground
//   power:HR decoupling and flat power change (|grade| < 3%, while every
//   surge measure uses climbs > 3%). Both are compared after partialling
//   out duration, since everything here grows with duration.
//
// No p-value is reported against "surges are evenly spread over a run":
// that null is false for terrain reasons alone, so beating it proves
// nothing. What is reported is the adjusted change, with its uncertainty.
import { loadPowerRuns, mean, partial, pearson, rank, rollingPower, type Sec } from "./powerRunHelpers.ts";

const BANDS: [number, number, string][] = [[0.03, 0.08, "3-8%"], [0.08, 0.15, "8-15%"], [0.15, 0.45, ">=15%"]];
const MIN_BAND_S = 180;
const LOCAL_WINDOW_S = 600;
const SURGE_OVER_LOCAL = 1.2;
const WALK_MS = 1.8;
// Sensitivity knobs: the surge definition should not be what decides the
// answer. --window= (s) for the rolling power, --q= for the peak quantile.
const argv = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SURGE_WINDOW_S = Number(argv("window") ?? 30);
const PEAK_Q = Number(argv("q") ?? 0.95);

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const { runs } = loadPowerRuns();

interface BandStats { n: number; meanP: number; p95: number; freq: number; walk: number }
interface RunRow {
  name: string; date: string; hours: number;
  dLogP95: number; dLogMean: number; dLogSpike: number; dFreq: number; dWalk: number;
  bandsUsed: string[]; flatDecoupling: number | null; flatPowerChange: number | null;
}
const rows: RunRow[] = [];

for (const run of runs) {
  const r30 = rollingPower(run.s, SURGE_WINDOW_S);
  const r10m = rollingPower(run.s, LOCAL_WINDOW_S);
  const idx = new Map(run.s.map((x, k) => [x.t, k]));
  const moving = run.s.filter((x) => x.moving);
  const third = Math.floor(moving.length / 3);
  const early = moving.slice(0, third), late = moving.slice(moving.length - third);

  const stats = (xs: Sec[], lo: number, hi: number): BandStats | null => {
    const b = xs.filter((x) => x.grade >= lo && x.grade < hi && x.t > 300);
    if (b.length < MIN_BAND_S) return null;
    const roll = b.map((x) => r30[idx.get(x.t)!]);
    return {
      n: b.length,
      meanP: mean(b.map((x) => x.power)),
      p95: pct(roll, PEAK_Q),
      freq: b.filter((x, i) => roll[i] > SURGE_OVER_LOCAL * r10m[idx.get(x.t)!]).length / b.length,
      walk: b.filter((x) => x.speed < WALK_MS).length / b.length,
    };
  };

  let w = 0, p95 = 0, mn = 0, sp = 0, fq = 0, wk = 0;
  const used: string[] = [];
  for (const [lo, hi, label] of BANDS) {
    const a = stats(early, lo, hi), b = stats(late, lo, hi);
    if (!a || !b) continue;
    const wt = Math.min(a.n, b.n);
    w += wt;
    p95 += wt * Math.log(b.p95 / a.p95);
    mn += wt * Math.log(b.meanP / a.meanP);
    sp += wt * Math.log(b.p95 / b.meanP / (a.p95 / a.meanP));
    fq += wt * (b.freq - a.freq);
    wk += wt * (b.walk - a.walk);
    used.push(label);
  }
  if (w === 0) continue;

  // independent fatigue measures, flat ground only -- disjoint seconds
  const flat = (xs: Sec[]) => xs.filter((x) => Math.abs(x.grade) < 0.03 && x.t > 600 && x.hr > 60);
  const fe = flat(early), fl = flat(late);
  const ok = fe.length > 300 && fl.length > 300;
  const ef = (xs: Sec[]) => mean(xs.map((x) => x.power)) / mean(xs.map((x) => x.hr));

  rows.push({
    name: run.name, date: run.date, hours: moving.length / 3600,
    dLogP95: p95 / w, dLogMean: mn / w, dLogSpike: sp / w, dFreq: fq / w, dWalk: wk / w, bandsUsed: used,
    flatDecoupling: ok ? ef(fl) / ef(fe) - 1 : null,
    flatPowerChange: ok ? mean(fl.map((x) => x.power)) / mean(fe.map((x) => x.power)) - 1 : null,
  });
}

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const bootMean = (xs: number[]) => {
  const b: number[] = [];
  for (let t = 0; t < 4000; t++) b.push(mean(xs.map(() => xs[Math.floor(rnd() * xs.length)])));
  b.sort((a, c) => a - c);
  return [b[Math.floor(0.025 * b.length)], b[Math.floor(0.975 * b.length)]];
};
const bootCorr = (f: (ix: number[]) => number, n: number) => {
  const b: number[] = [];
  for (let t = 0; t < 4000; t++) {
    const v = f(Array.from({ length: n }, () => Math.floor(rnd() * n)));
    if (Number.isFinite(v)) b.push(v);
  }
  b.sort((a, c) => a - c);
  return [b[Math.floor(0.025 * b.length)], b[Math.floor(0.975 * b.length)]];
};
const pc = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const ex = (v: number) => pc(Math.exp(v) - 1);

console.log(`${rows.length} runs >= 90 min with measured power. Changes are LAST third vs FIRST third,`);
console.log(`on climbs only, gradient-band matched (need ${MIN_BAND_S}s on a band in both thirds).\n`);
console.log("date        run                             hours  bands          peak(p95)  mean   spikiness  surge freq  walk share");
for (const r of rows.sort((a, b) => a.hours - b.hours)) {
  console.log(
    `${r.date}  ${r.name.slice(0, 30).padEnd(31)} ${r.hours.toFixed(1).padStart(5)}  ${r.bandsUsed.join(",").padEnd(13)} ` +
      `${ex(r.dLogP95).padStart(8)} ${ex(r.dLogMean).padStart(7)} ${ex(r.dLogSpike).padStart(9)}   ` +
      `${(r.dFreq >= 0 ? "+" : "") + (r.dFreq * 100).toFixed(1)}pp`.padStart(8) +
      `   ${(r.dWalk >= 0 ? "+" : "") + (r.dWalk * 100).toFixed(1)}pp`.padStart(9),
  );
}

console.log("\n1. Do surges shrink late in a run? (mean across runs, 95% bootstrap CI)\n");
for (const [label, get, fmt] of [
  ["peak climb power (p95 of 30 s)", (r: RunRow) => r.dLogP95, ex],
  ["mean climb power", (r: RunRow) => r.dLogMean, ex],
  ["spikiness (peak / mean) -- beyond the mean shift", (r: RunRow) => r.dLogSpike, ex],
  ["surge frequency vs current 10 min level", (r: RunRow) => r.dFreq, (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`],
] as const) {
  const xs = rows.map(get);
  const [lo, hi] = bootMean(xs);
  console.log(`  ${label.padEnd(50)} ${fmt(mean(xs)).padStart(8)}  [${fmt(lo)}, ${fmt(hi)}]   lower late in ${xs.filter((v) => v < 0).length}/${xs.length} runs`);
}

console.log("\n2. Does the loss grow with run length? (Spearman vs moving hours, 95% bootstrap CI)\n");
for (const [label, get] of [
  ["peak climb power", (r: RunRow) => r.dLogP95],
  ["spikiness", (r: RunRow) => r.dLogSpike],
  ["surge frequency", (r: RunRow) => r.dFreq],
] as const) {
  const xs = rows.map((r) => r.hours), ys = rows.map(get);
  const rho = pearson(rank(xs), rank(ys));
  const [lo, hi] = bootCorr((ix) => pearson(rank(ix.map((i) => xs[i])), rank(ix.map((i) => ys[i]))), xs.length);
  console.log(`  ${label.padEnd(20)} rho ${rho >= 0 ? "+" : ""}${rho.toFixed(2)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
}

console.log("\n3. Does it track independent fatigue measured on FLAT ground (disjoint seconds)?");
console.log("   partial Spearman, controlling for log(duration)\n");
for (const [fname, fget] of [
  ["flat power:HR decoupling", (r: RunRow) => r.flatDecoupling],
  ["flat power change", (r: RunRow) => r.flatPowerChange],
] as const) {
  for (const [label, get] of [
    ["peak climb power", (r: RunRow) => r.dLogP95],
    ["spikiness", (r: RunRow) => r.dLogSpike],
    ["surge frequency", (r: RunRow) => r.dFreq],
  ] as const) {
    const ok = rows.filter((r) => fget(r) !== null);
    const xs = ok.map(get), ys = ok.map((r) => fget(r)!), c = ok.map((r) => Math.log(r.hours));
    const p = partial(xs, ys, [c]);
    const [lo, hi] = bootCorr((ix) => partial(ix.map((i) => xs[i]), ix.map((i) => ys[i]), [ix.map((i) => c[i])]), ok.length);
    console.log(`  ${`${label} ~ ${fname}`.padEnd(48)} n=${ok.length}  partial ${p >= 0 ? "+" : ""}${p.toFixed(2)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
  }
}
