// Two questions at once, on the same gradient bands:
//
// 1. PACING SHAPE. The solver holds one flat power level for the whole
//    race. A real racer surges the climbs. For a fixed course at a fixed
//    TIME-averaged power, putting power where you spend the most time --
//    the climbs -- finishes sooner, so flat pacing may be leaving time on
//    the table rather than being optimal.
// 2. WALKING. Where the solver switches to walking versus where the
//    athlete actually did.
//
// Compares recorded speed and recorded gross power against the solver's,
// band by band, so both show up as a shape rather than a single number.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { analyzeRun } from "../src/model/analysis.ts";
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

const RACES = [
  { id: 14579457702, name: "Ecotrail 80" },
  { id: 15777092101, name: "Askerspurten 10 km" },
];
const BANDS: [number, number, string][] = [
  [0.15, 9, "  >+15%"], [0.08, 0.15, "  +8..15%"], [0.03, 0.08, "  +3..8%"],
  [-0.03, 0.03, "   flat"], [-0.08, -0.03, "  -3..8%"], [-0.15, -0.08, "  -8..15%"], [-9, -0.15, "  <-15%"],
];
const pace = (ms: number) => (ms > 0 ? `${Math.floor(1000 / ms / 60)}:${String(Math.round((1000 / ms) % 60)).padStart(2, "0")}` : "  --");

const applied: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: [{ date: "2026-01-01", value: VO2, source: "manual" as const }],
  durationCurve: "powerLaw", powerLawFraction60Min: 0.799, powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 },
};

// Fit the descent cap once, from everything, so the solver runs as the app
// now would rather than against the old hard-coded default.
import { readdirSync } from "node:fs";
const allRuns: CourseSegment[][] = [];
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}${f}`, "utf8"));
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (pts.length < 50) continue;
    const c = runPipeline(pts);
    if (c.hasTimestamps) allRuns.push(c.segments);
  } catch { /* skip */ }
}
const capCurve = fitDescentCapCurve(buildDescentCapObservations(allRuns)).curve;

for (const race of RACES) {
  const raw = JSON.parse(readFileSync(`${CACHE}activity-${race.id}.json`, "utf8"));
  const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(pts);
  const sp = `${SURFACE}${race.id}.json`;
  const segments = existsSync(sp)
    ? attachSurfaceData(course.segments, JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[])
    : course.segments;

  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(applied);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...applied, lt1Fraction, lt2Fraction });
  const ceilingParams = resolveCeilingParams(applied);
  const si: SolverInputs = {
    segments, ceilingParams, bodyMassKg: applied.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: applied.foPeakGPerMin },
    fueling: { intakeGPerH: applied.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(applied),
    walkMaxMs: applied.walkMaxMs, altitudeAdjustment: applied.altitudeAdjustment,
    anaerobicCapacityMin: applied.anaerobicCapacityMin,
    surfaceCostMultipliers: applied.surfaceCostMultipliers ?? undefined,
    descentPacingInCeiling: true, descentCapCurve: capCurve,
  };
  const sim = findFlatPacedFinishTime(si).result;
  const actual = analyzeRun(segments, {
    bodyMassKg: applied.bodyMassKg, ceilingParams,
    fueling: { intakeGPerH: applied.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(applied),
    walkMaxMs: applied.walkMaxMs, altitudeAdjustment: applied.altitudeAdjustment,
  });

  console.log(`\n${"=".repeat(96)}\n${race.name}`);
  console.log("band        dist    YOUR pace  YOUR power   MODEL pace  MODEL power   model walks   you <2m/s");
  let aWork = 0, aTime = 0, sWork = 0, sTime = 0;
  for (const [lo, hi, label] of BANDS) {
    let m = 0, at = 0, ap = 0, st = 0, spw = 0, walkM = 0, slowM = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.gradient < lo || seg.gradient >= hi) continue;
      const a = actual.segments[i], s = sim.segments[i];
      if (!a || !s || seg.paused || !(seg.dtS! > 0)) continue;
      m += seg.distance3D;
      at += seg.dtS!; ap += a.grossPowerWPerKg * seg.dtS!;
      st += s.timeS; spw += s.grossPowerWPerKg * s.timeS;
      if (s.mode === "walk") walkM += seg.distance3D;
      if (seg.distance3D / seg.dtS! < 2.0) slowM += seg.distance3D;
    }
    if (m < 100) continue;
    aWork += ap; aTime += at; sWork += spw; sTime += st;
    console.log(
      `${label.padEnd(11)} ${(m / 1000).toFixed(1).padStart(5)} km  ${pace(m / at).padStart(8)}/km ` +
        `${(ap / at).toFixed(2).padStart(7)} W/kg  ${pace(m / st).padStart(8)}/km ${(spw / st).toFixed(2).padStart(7)} W/kg  ` +
        `${((walkM / m) * 100).toFixed(0).padStart(8)}%  ${((slowM / m) * 100).toFixed(0).padStart(8)}%`,
    );
  }
  console.log(
    `\n  time-averaged power -- you ${(aWork / aTime).toFixed(2)} W/kg, model ${(sWork / sTime).toFixed(2)} W/kg`,
  );
}
