// What this athlete's walking actually looks like, by gradient, against
// what the solver does at the same gradients.
//
// On steep climbs a runner is certainly walking, so the recorded speed
// there IS their walking speed -- no gait inference needed. Lower down it
// is ambiguous, which is the point: the distribution shows where the real
// walk/run transition sits.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { costOfRunning, costOfWalking } from "../src/model/minetti.ts";
import { buildDescentCapObservations, fitDescentCapCurve } from "../src/model/pacingFit.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG,
  resolveLt1Lt2Fractions, resolveSubstrateAnchors, type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const pace = (ms: number) => (ms > 0 ? `${Math.floor(1000 / ms / 60)}:${String(Math.round((1000 / ms) % 60)).padStart(2, "0")}` : " -- ");

function load(id: number): CourseSegment[] | null {
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}activity-${id}.json`, "utf8"));
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (pts.length < 50) return null;
    const c = runPipeline(pts);
    if (!c.hasTimestamps) return null;
    const sp = `${SURFACE}${id}.json`;
    return existsSync(sp) ? attachSurfaceData(c.segments, JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[]) : c.segments;
  } catch { return null; }
}

// --- what the athlete actually does on climbs, across everything ---------
const BANDS: [number, number][] = [[0.03, 0.06], [0.06, 0.09], [0.09, 0.12], [0.12, 0.16], [0.16, 0.22], [0.22, 0.45]];
const acc = BANDS.map(() => [] as { v: number; m: number }[]);
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const segs = load(Number(f.slice(9, -5)));
  if (!segs) continue;
  for (const s of segs) {
    if (s.paused || s.dtS === null || s.dtS <= 0 || s.distance3D <= 0) continue;
    const v = s.distance3D / s.dtS;
    if (!(v > 0) || v > 8) continue;
    const bi = BANDS.findIndex(([lo, hi]) => s.gradient >= lo && s.gradient < hi);
    if (bi >= 0) acc[bi].push({ v, m: s.distance3D });
  }
}
function wq(rows: { v: number; m: number }[], p: number): number {
  const sorted = [...rows].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((a, r) => a + r.m, 0);
  let seen = 0;
  for (const r of sorted) { seen += r.m; if (seen >= p * total) return r.v; }
  return sorted[sorted.length - 1]?.v ?? 0;
}
console.log("YOUR recorded climbing speed, all runs (a runner is certainly walking by ~+16%)\n");
console.log("gradient      distance    p25 pace    median      p75       p95    walk cheaper than run?");
for (let i = 0; i < BANDS.length; i++) {
  const rows = acc[i];
  if (rows.length === 0) continue;
  const m = rows.reduce((a, r) => a + r.m, 0);
  const mid = (BANDS[i][0] + BANDS[i][1]) / 2;
  const cheaper = costOfWalking(mid) < costOfRunning(mid);
  console.log(
    `  +${(BANDS[i][0] * 100).toFixed(0)}..${(BANDS[i][1] * 100).toFixed(0)}%   ${(m / 1000).toFixed(1).padStart(7)} km   ` +
      `${pace(wq(rows, 0.25)).padStart(7)}   ${pace(wq(rows, 0.5)).padStart(7)}   ${pace(wq(rows, 0.75)).padStart(7)}   ${pace(wq(rows, 0.95)).padStart(7)}   ` +
      `${cheaper ? `yes (${(costOfWalking(mid) / costOfRunning(mid)).toFixed(2)}x)` : "no"}`,
  );
}

// --- what the solver does on Ecotrail's climbs --------------------------
const all: CourseSegment[][] = [];
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const s = load(Number(f.slice(9, -5)));
  if (s) all.push(s);
}
const capCurve = fitDescentCapCurve(buildDescentCapObservations(all)).curve;
const inp: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: [{ date: "2026-01-01", value: 55, source: "manual" as const }],
  durationCurve: "powerLaw", powerLawFraction60Min: 0.799, powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 },
};
const segments = load(14579457702)!;
const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(inp);
const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...inp, lt1Fraction, lt2Fraction });
const si: SolverInputs = {
  segments, ceilingParams: resolveCeilingParams(inp), bodyMassKg: inp.bodyMassKg,
  substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: inp.foPeakGPerMin },
  fueling: { intakeGPerH: inp.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(inp),
  walkMaxMs: inp.walkMaxMs, altitudeAdjustment: inp.altitudeAdjustment,
  anaerobicCapacityMin: inp.anaerobicCapacityMin, surfaceCostMultipliers: inp.surfaceCostMultipliers ?? undefined,
  descentPacingInCeiling: true, descentCapCurve: capCurve,
};
const r = findFlatPacedFinishTime(si).result;
console.log("\nEcotrail 80 climbs -- YOU vs the MODEL\n");
console.log("gradient      distance    your pace    model pace   model walks");
for (const [lo, hi] of BANDS) {
  let m = 0, at = 0, st = 0, walkM = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i], sim = r.segments[i];
    if (!s || !sim || s.paused || s.dtS === null || s.dtS <= 0) continue;
    if (s.gradient < lo || s.gradient >= hi) continue;
    m += s.distance3D; at += s.dtS; st += sim.timeS;
    if (sim.mode === "walk") walkM += s.distance3D;
  }
  if (m < 100) continue;
  console.log(
    `  +${(lo * 100).toFixed(0)}..${(hi * 100).toFixed(0)}%   ${(m / 1000).toFixed(1).padStart(7)} km   ` +
      `${pace(m / at).padStart(8)}/km  ${pace(m / st).padStart(8)}/km   ${((walkM / m) * 100).toFixed(0).padStart(6)}%`,
  );
}
