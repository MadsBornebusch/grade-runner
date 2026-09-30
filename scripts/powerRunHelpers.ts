// Shared by the power-surge diagnostics: 1 Hz measured-power runs, loaded
// with gradient from the pipeline's own smoothed segments, plus the small
// rank-statistics toolkit both analyses report with.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { solveLinearSystem } from "../src/model/linearSolve.ts";

export const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
export const POWER_FROM = "2024-11-28";
export const MIN_MOVING_S = 90 * 60;
export const MOVING_SPEED_MS = 0.5;

export interface Meta { stravaId: number; name: string; date: string }
export const meta = new Map((JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Meta[]).map((a) => [a.stravaId, a]));

export function hav(a: GpxPoint, b: GpxPoint): number {
  const R = 6371000, p1 = (a.lat * Math.PI) / 180, p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1, dl = ((b.lon - a.lon) * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
}

export interface Sec { t: number; power: number; hr: number; speed: number; grade: number; moving: boolean }

/** One second per sample, with gradient taken from the pipeline's own
 * smoothed 25 m segments rather than re-derived from noisy 1 Hz elevation. */
export function loadSeconds(id: number): Sec[] | null {
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
export function rollingPower(s: Sec[], win: number): number[] {
  const r: number[] = [];
  let lo = 0, sum = 0;
  for (let k = 0; k < s.length; k++) {
    sum += s[k].power;
    while (s[k].t - s[lo].t >= win) { sum -= s[lo].power; lo++; }
    r.push(sum / (k - lo + 1));
  }
  return r;
}


export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ---- statistics --------------------------------------------------------------
export const rank = (xs: number[]) => {
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
export const pearson = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
};
export const residualize = (y: number[], X: number[][]) => {
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
export const partial = (x: number[], y: number[], C: number[][]) => {
  const rc = C.map(rank);
  const X = x.map((_, i) => rc.map((c) => c[i]));
  return pearson(residualize(rank(x), X), residualize(rank(y), X));
};

/** Every cached run with measured power, and the best 60 min power across
 * all of them -- the fixed threshold the first surge analysis used. */
export function loadPowerRuns(minMovingS = MIN_MOVING_S) {
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
    if (s.filter((x) => x.moving).length >= minMovingS) runs.push({ id, name: m.name, date: m.date.slice(0, 10), s });
  }
  return { runs, best60 };
}
