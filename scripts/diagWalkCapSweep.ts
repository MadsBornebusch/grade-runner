// Is the walk model actually a lever on finish time, before building any
// fit for it? Sweeps walkMaxMs (hard-coded at 2.0 in DEFAULT_FORM_INPUTS)
// and reports finish time and walk share per race.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildDescentCapObservations, fitDescentCapCurve } from "../src/model/pacingFit.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG,
  resolveLt1Lt2Fractions, resolveSubstrateAnchors, type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VO2 = Number(arg("vo2max") ?? 55);
const SWEEP = [1.6, 2.0, 2.4, 2.8, 99];

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

const all: CourseSegment[][] = [];
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const s = load(Number(f.slice(9, -5)));
  if (s) all.push(s);
}
const capCurve = fitDescentCapCurve(buildDescentCapObservations(all)).curve;

const base: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: [{ date: "2026-01-01", value: VO2, source: "manual" as const }],
  durationCurve: "powerLaw", powerLawFraction60Min: 0.799, powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 },
};
const hms = (s: number) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const RACES = [
  { id: 15777092101, name: "Askerspurten 10", actualS: 2525 },
  { id: 14579457702, name: "Ecotrail 80", actualS: 30151 },
  { id: 12524841443, name: "OTC 55", actualS: 25561 },
];

function predict(segments: CourseSegment[], walkMaxMs: number) {
  const inp: FormInputs = { ...base, walkMaxMs };
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(inp);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...inp, lt1Fraction, lt2Fraction });
  const si: SolverInputs = {
    segments, ceilingParams: resolveCeilingParams(inp), bodyMassKg: inp.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: inp.foPeakGPerMin },
    fueling: { intakeGPerH: inp.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(inp),
    walkMaxMs, altitudeAdjustment: inp.altitudeAdjustment, anaerobicCapacityMin: inp.anaerobicCapacityMin,
    surfaceCostMultipliers: inp.surfaceCostMultipliers ?? undefined,
    descentPacingInCeiling: true, descentCapCurve: capCurve,
  };
  const r = findFlatPacedFinishTime(si).result;
  let walkM = 0, totM = 0;
  for (let i = 0; i < r.segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    totM += seg.distance3D;
    if (r.segments[i].mode === "walk") walkM += seg.distance3D;
  }
  return { t: r.finishTimeS, walkPct: (walkM / totM) * 100 };
}

console.log("walkMaxMs sweep -- 2.0 m/s is the hard-coded default; 99 effectively removes the cap\n");
console.log("race              actual  " + SWEEP.map((w) => `walkMax ${w}`.padStart(17)).join(""));
for (const race of RACES) {
  const segs = load(race.id);
  if (!segs) continue;
  const cells = SWEEP.map((w) => {
    const p = predict(segs, w);
    return `${hms(p.t)} ${(((p.t - race.actualS) / race.actualS) * 100).toFixed(1).padStart(5)}%`.padStart(17);
  });
  console.log(`${race.name.padEnd(16)} ${hms(race.actualS)} ${cells.join("")}`);
}
console.log();
for (const race of RACES) {
  const segs = load(race.id);
  if (!segs) continue;
  console.log(
    `${race.name.padEnd(16)} walk share:  ` + SWEEP.map((w) => `${w}: ${predict(segs, w).walkPct.toFixed(0)}%`).join("   "),
  );
}
