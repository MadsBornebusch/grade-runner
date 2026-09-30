// Hypothesis under test (the athlete's): the frequency of high power peaks
// -- running into a hill a bit too fast early on -- is correlated with
// muscular fatigue later.
//
// Design, fixed BEFORE looking at any result:
//
// - Population: runs >= 90 min moving with measured footpod power and HR on
//   >80% of samples (power appears on every run from 2024-11-28 and never
//   before, reads 0 W when stationary, and correlates only ~0.4 with GPS
//   speed -- a sensor, not a speed-derived estimate).
// - Exposure: EARLY surge burden -- share of first-third moving time whose
//   30 s rolling power exceeds the athlete's best-ever 60 min power (a
//   critical-power proxy on the same Stryd scale), split by the gradient it
//   happened on. Early and late are separated deliberately: a late surge is
//   contemporaneous with fatigue and says nothing about direction.
// - Outcomes, each last third vs first third (negative = fatigue):
//     1. power:HR efficiency (decoupling) -- more heartbeats per watt
//     2. power at matched gradient -- what you can still put out
//     3. descent speed on -8..-20% -- the most muscle-specific marker, since
//        late descending is limited by eccentric damage rather than by fuel
//        or heart rate
// - Controls: log duration, climb per km, and overall early intensity
//   (first-third mean power / threshold). Hilly and long runs have more of
//   BOTH surges and fatigue; without these the hunch confirms itself.
//
// n is ~30. Everything below is reported with its uncertainty; a partial
// correlation that doesn't survive the permutation test is reported as
// such, not rounded up.
import {
  loadPowerRuns, mean, partial, pearson, rank, rollingPower, type Sec,
} from "./powerRunHelpers.ts";

// ---- pass 1: the threshold -- best 60 min power across every power run -----
const { runs, best60 } = loadPowerRuns();

// ---- pass 2: exposure and outcomes per run ----------------------------------
interface Row {
  name: string; date: string; hours: number; climbPerKm: number; earlyIntensity: number;
  surgeClimb: number; surgeFlat: number; surgeAll: number;
  /** First-third variability index: normalized power (4th-power mean of
   * 30 s rolling power, 4th root) over average power. The standard measure
   * of "spiky vs smooth at the same average" -- and, unlike the surge
   * burden, not built on the same threshold that early intensity is
   * measured against, so it is far less collinear with that control. */
  earlyVI: number;
  decoupling: number | null; powerFade: number | null; descentFade: number | null;
  /** Same three outcomes, last third vs MIDDLE third. The first-third
   * versions share a window with the exposure: surge seconds sit inside the
   * first-third climb-power baseline (inflating it, so the ratio falls by
   * arithmetic), and HR lags a 30 s surge (inflating first-third power:HR).
   * These cannot be contaminated that way. */
  decouplingML: number | null; powerFadeML: number | null; descentFadeML: number | null;
}
const rows: Row[] = [];

for (const run of runs) {
  const moving = run.s.filter((x) => x.moving);
  const n = moving.length;
  const third = Math.floor(n / 3);
  const first = moving.slice(0, third), middle = moving.slice(third, n - third), last = moving.slice(n - third);
  const r30 = rollingPower(run.s, 30);
  const r30ByT = new Map(run.s.map((x, k) => [x.t, r30[k]]));

  const surge = (sel: (g: number) => boolean) =>
    first.filter((x) => sel(x.grade) && (r30ByT.get(x.t) ?? 0) > best60).length / first.length;

  // decoupling: exclude the first 10 min (HR still rising) and steep ground
  const ef = (xs: Sec[]) => {
    const ok = xs.filter((x) => x.t > 600 && Math.abs(x.grade) < 0.08 && x.hr > 60);
    return ok.length > 300 ? mean(ok.map((x) => x.power)) / mean(ok.map((x) => x.hr)) : null;
  };
  const decoup = (base: Sec[], late: Sec[]) => {
    const a = ef(base), b = ef(late);
    return a && b ? b / a - 1 : null;
  };

  // matched-gradient power: compare bin by bin, weight by the smaller count
  const bins: [number, number][] = [[-0.03, 0.03], [0.03, 0.08], [0.08, 0.15]];
  const pwrFade = (base: Sec[], late: Sec[]) => {
    let num = 0, wsum = 0;
    for (const [lo, hi] of bins) {
      const a = base.filter((x) => x.grade >= lo && x.grade < hi), b = late.filter((x) => x.grade >= lo && x.grade < hi);
      if (a.length < 120 || b.length < 120) continue;
      const w = Math.min(a.length, b.length);
      num += w * (mean(b.map((x) => x.power)) / mean(a.map((x) => x.power)) - 1);
      wsum += w;
    }
    return wsum > 0 ? num / wsum : null;
  };

  const dsc = (xs: Sec[]) => xs.filter((x) => x.grade <= -0.08 && x.grade > -0.2).map((x) => x.speed);
  const dscFade = (base: Sec[], late: Sec[]) => {
    const a = dsc(base), b = dsc(late);
    return a.length > 120 && b.length > 120 ? mean(b) / mean(a) - 1 : null;
  };

  let climbM = 0, distM = 0;
  for (let k = 1; k < moving.length; k++) {
    const dd = moving[k].speed * Math.max(0, Math.min(5, moving[k].t - moving[k - 1].t));
    distM += dd;
    if (moving[k].grade > 0) climbM += dd * moving[k].grade;
  }

  rows.push({
    name: run.name, date: run.date, hours: n / 3600, climbPerKm: climbM / (distM / 1000),
    earlyIntensity: mean(first.map((x) => x.power)) / best60,
    surgeClimb: surge((g) => g > 0.03), surgeFlat: surge((g) => Math.abs(g) <= 0.03), surgeAll: surge(() => true),
    earlyVI: (() => {
      const rp = first.map((x) => r30ByT.get(x.t) ?? 0);
      const np = Math.pow(mean(rp.map((v) => v ** 4)), 0.25);
      return np / mean(first.map((x) => x.power));
    })(),
    decoupling: decoup(first, last), powerFade: pwrFade(first, last), descentFade: dscFade(first, last),
    decouplingML: decoup(middle, last), powerFadeML: pwrFade(middle, last), descentFadeML: dscFade(middle, last),
  });
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function analyse(label: string, xs: number[], ys: number[], controls: number[][]) {
  const raw = pearson(rank(xs), rank(ys));
  const p = partial(xs, ys, controls);
  // permutation test on the partial correlation
  let extreme = 0;
  const PERMS = 5000;
  for (let t = 0; t < PERMS; t++) {
    const perm = [...xs];
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    if (Math.abs(partial(perm, ys, controls)) >= Math.abs(p)) extreme++;
  }
  // bootstrap CI
  const boots: number[] = [];
  for (let t = 0; t < 2000; t++) {
    const idx = xs.map(() => Math.floor(rnd() * xs.length));
    const v = partial(idx.map((i) => xs[i]), idx.map((i) => ys[i]), controls.map((c) => idx.map((i) => c[i])));
    if (Number.isFinite(v)) boots.push(v);
  }
  boots.sort((a, b) => a - b);
  const lo = boots[Math.floor(0.025 * boots.length)], hi = boots[Math.floor(0.975 * boots.length)];
  console.log(
    `  ${label.padEnd(44)} n=${String(xs.length).padStart(2)}  raw rho ${raw >= 0 ? "+" : ""}${raw.toFixed(2)}   ` +
      `partial ${p >= 0 ? "+" : ""}${p.toFixed(2)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]  perm p=${(extreme / PERMS).toFixed(3)}`,
  );
}

console.log(`Threshold: best 60 min power across all power runs = ${best60.toFixed(0)} W`);
console.log(`Runs >= 90 min moving with measured power + HR: ${rows.length}\n`);
console.log("date        run                             hours  climb/km  earlyInt  surge(all/climb/flat)   decoup  pwrFade  descFade");
for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
  const f = (v: number | null) => (v === null ? "   --  " : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`.padStart(7));
  console.log(
    `${r.date}  ${r.name.slice(0, 30).padEnd(31)} ${r.hours.toFixed(1).padStart(5)}  ${r.climbPerKm.toFixed(0).padStart(6)}m   ` +
      `${(r.earlyIntensity * 100).toFixed(0).padStart(5)}%   ${(r.surgeAll * 100).toFixed(1).padStart(5)}/${(r.surgeClimb * 100).toFixed(1).padStart(5)}/${(r.surgeFlat * 100).toFixed(1).padStart(5)}%    ` +
      `${f(r.decoupling)} ${f(r.powerFade)} ${f(r.descentFade)}`,
  );
}

console.log("\nEarly surge burden vs late fatigue -- Spearman, then partial controlling for log(duration), climb/km, early intensity");
console.log("(fatigue outcomes are negative when worse, so the hunch predicts NEGATIVE correlations)\n");
for (const [outName, get] of [
  ["[first->last] power:HR decoupling", (r: Row) => r.decoupling],
  ["[first->last] power @ matched grade", (r: Row) => r.powerFade],
  ["[first->last] descent speed", (r: Row) => r.descentFade],
  ["[middle->last] power:HR decoupling", (r: Row) => r.decouplingML],
  ["[middle->last] power @ matched grade", (r: Row) => r.powerFadeML],
  ["[middle->last] descent speed", (r: Row) => r.descentFadeML],
] as const) {
  for (const [expName, ex] of [
    ["all surges", (r: Row) => r.surgeAll],
    ["surges on climbs (>3%)", (r: Row) => r.surgeClimb],
    ["surges on the flat", (r: Row) => r.surgeFlat],
  ] as const) {
    const ok = rows.filter((r) => get(r) !== null);
    analyse(`${outName} ~ ${expName}`, ok.map(ex), ok.map((r) => get(r)!), [
      ok.map((r) => Math.log(r.hours)), ok.map((r) => r.climbPerKm), ok.map((r) => r.earlyIntensity),
    ]);
  }
  console.log();
}

// leave-one-out on the strongest first->last result: is it one run?
{
  const ok = rows.filter((r) => r.powerFade !== null);
  const C = (xs: Row[]) => [xs.map((r) => Math.log(r.hours)), xs.map((r) => r.climbPerKm), xs.map((r) => r.earlyIntensity)];
  const vals = ok.map((_, i) => {
    const sub = ok.filter((__, j) => j !== i);
    return { name: ok[i].name + " " + ok[i].date, v: partial(sub.map((r) => r.surgeClimb), sub.map((r) => r.powerFade!), C(sub)) };
  }).sort((a, b) => b.v - a.v);
  console.log(`leave-one-out, power @ matched grade [first->last] ~ climb surges: partial ranges ${vals[vals.length - 1].v.toFixed(2)} .. ${vals[0].v.toFixed(2)}`);
  console.log(`  dropping ${vals[0].name} weakens it most (-> ${vals[0].v.toFixed(2)})\n`);
}

// Convergent check with a less collinear exposure. If "spiky at the same
// average" is what matters, variability index should tell the same story as
// surge burden while leaning far less on early intensity.
console.log("Variability index (first third) vs late fatigue, middle->last -- controls: log(duration), climb/km, early intensity");
{
  const C = (xs: Row[]) => [xs.map((r) => Math.log(r.hours)), xs.map((r) => r.climbPerKm), xs.map((r) => r.earlyIntensity)];
  for (const [outName, get] of [
    ["power:HR decoupling", (r: Row) => r.decouplingML],
    ["power @ matched grade", (r: Row) => r.powerFadeML],
  ] as const) {
    const ok = rows.filter((r) => get(r) !== null);
    analyse(`${outName} ~ early VI`, ok.map((r) => r.earlyVI), ok.map((r) => get(r)!), C(ok));
  }
  const vi = rows.map((r) => r.earlyVI);
  console.log(`  VI vs early intensity (Spearman): ${pearson(rank(vi), rank(rows.map((r) => r.earlyIntensity))).toFixed(2)}` +
    `   (surge burden vs early intensity was 0.86)\n`);
}

// how entangled is the exposure with the controls? if it is mostly early
// intensity under another name, the partial has little left to work with
const all = rows.map((r) => r.surgeAll);
console.log("exposure vs controls (Spearman):",
  `duration ${pearson(rank(all), rank(rows.map((r) => r.hours))).toFixed(2)},`,
  `climb/km ${pearson(rank(all), rank(rows.map((r) => r.climbPerKm))).toFixed(2)},`,
  `early intensity ${pearson(rank(all), rank(rows.map((r) => r.earlyIntensity))).toFixed(2)}`);
