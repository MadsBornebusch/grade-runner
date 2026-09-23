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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { solveLinearSystem } from "../src/model/linearSolve.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const POWER_FROM = "2024-11-28";
const MIN_MOVING_S = 90 * 60;
const MOVING_SPEED_MS = 0.5;

interface Meta { stravaId: number; name: string; date: string }
const meta = new Map((JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Meta[]).map((a) => [a.stravaId, a]));

function hav(a: GpxPoint, b: GpxPoint): number {
  const R = 6371000, p1 = (a.lat * Math.PI) / 180, p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1, dl = ((b.lon - a.lon) * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
}

interface Sec { t: number; power: number; hr: number; speed: number; grade: number; moving: boolean }

/** One second per sample, with gradient taken from the pipeline's own
 * smoothed 25 m segments rather than re-derived from noisy 1 Hz elevation. */
function loadSeconds(id: number): Sec[] | null {
  let raw: any;
  try { raw = JSON.parse(readFileSync(`${CACHE}activity-${id}.json`, "utf8")); } catch { return null; }
  const pts: GpxPoint[] = (raw.points ?? []).map((p: any) => ({
    lat: p.lat, lon: p.lon, ele: p.ele ?? null, time: p.time ? new Date(p.time) : null,
    hr: p.hr ?? null, power: p.power ?? null,
  }));
  if (pts.length < 600 || !pts[0].time) return null;
  const cov = (f: (p: GpxPoint) => unknown) => pts.filter((p) => f(p)).length / pts.length;
  if (cov((p) => p.power) < 0.8 || cov((p) => p.hr) < 0.8) return null;

  const course = runPipeline(pts);
  const segEnds: number[] = [];
  let acc = 0;
  for (const s of course.segments) { acc += s.distanceHorizontal; segEnds.push(acc); }
  const gradeAt = (d: number) => {
    let lo = 0, hi = segEnds.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (segEnds[m] < d) lo = m + 1; else hi = m; }
    return course.segments[lo]?.gradient ?? 0;
  };

  const out: Sec[] = [];
  let cum = 0;
  for (let k = 1; k < pts.length; k++) {
    const dt = (pts[k].time!.getTime() - pts[k - 1].time!.getTime()) / 1000;
    const dd = hav(pts[k - 1], pts[k]);
    cum += dd;
    if (!(dt > 0) || dt > 5) continue; // a gap is a pause, not a moving second
    const speed = dd / dt;
    out.push({
      t: (pts[k].time!.getTime() - pts[0].time!.getTime()) / 1000,
      power: pts[k].power ?? 0, hr: pts[k].hr ?? 0, speed,
      grade: gradeAt(cum), moving: speed > MOVING_SPEED_MS && (pts[k].power ?? 0) > 0,
    });
  }
  // smooth the moving flag over 10 s so a single slow GPS second doesn't
  // punch holes in a steady effort
  for (let k = 0; k < out.length; k++) {
    let sp = 0, n = 0;
    for (let j = Math.max(0, k - 5); j <= Math.min(out.length - 1, k + 5); j++) { sp += out[j].speed; n++; }
    out[k].moving = sp / n > MOVING_SPEED_MS && out[k].power > 0;
  }
  return out;
}

/** Rolling mean of power over the trailing `win` seconds of elapsed time. */
function rollingPower(s: Sec[], win: number): number[] {
  const r: number[] = [];
  let lo = 0, sum = 0;
  for (let k = 0; k < s.length; k++) {
    sum += s[k].power;
    while (s[k].t - s[lo].t >= win) { sum -= s[lo].power; lo++; }
    r.push(sum / (k - lo + 1));
  }
  return r;
}

// ---- pass 1: the threshold -- best 60 min power across every power run -----
const runs: { id: number; name: string; date: string; s: Sec[] }[] = [];
let best60 = 0;
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const id = Number(f.slice(9, -5));
  const m = meta.get(id);
  if (!m || m.date.slice(0, 10) < POWER_FROM) continue;
  const s = loadSeconds(id);
  if (!s) continue;
  const r60 = rollingPower(s, 3600);
  for (let k = 0; k < s.length; k++) if (s[k].t >= 3600) best60 = Math.max(best60, r60[k]);
  const movingS = s.filter((x) => x.moving).length;
  if (movingS >= MIN_MOVING_S) runs.push({ id, name: m.name, date: m.date.slice(0, 10), s });
}

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
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

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

// ---- statistics --------------------------------------------------------------
const rank = (xs: number[]) => {
  const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r as number[];
};
const pearson = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
};
const residualize = (y: number[], X: number[][]) => {
  const k = X[0].length + 1;
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < y.length; i++) {
    const row = [1, ...X[i]];
    for (let p = 0; p < k; p++) { b[p] += row[p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += row[p] * row[q]; }
  }
  const beta = solveLinearSystem(A, b)!;
  return y.map((v, i) => v - [1, ...X[i]].reduce((s, x, p) => s + x * beta[p], 0));
};
/** Spearman partial correlation: residualize both ranks on the controls' ranks. */
const partial = (x: number[], y: number[], C: number[][]) => {
  const rc = C.map(rank);
  const X = x.map((_, i) => rc.map((c) => c[i]));
  return pearson(residualize(rank(x), X), residualize(rank(y), X));
};
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
