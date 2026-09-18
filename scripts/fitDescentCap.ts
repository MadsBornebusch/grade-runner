// Fits this athlete's descent-speed cap from every cached run, prints the
// evidence behind it, and re-runs the three reference race predictions
// with the fitted curve in place of the hard-coded default.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { DEFAULT_DESCENT_CAP_CURVE, gradeOnlyMaxDescentSpeedMs, type DescentCapCurve } from "../src/model/minetti.ts";
import { buildDescentCapObservations, fitDescentCapCurve } from "../src/model/pacingFit.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG,
  resolveLt1Lt2Fractions, resolveSubstrateAnchors, type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VO2 = Number(arg("vo2max") ?? 55);

const pace = (ms: number) => (ms <= 0 || !Number.isFinite(ms) ? "  --  " : `${Math.floor(1000 / ms / 60)}:${String(Math.round((1000 / ms) % 60)).padStart(2, "0")}`);
const hms = (s: number) => {
  const t = Math.round(Math.abs(s));
  return `${s < 0 ? "-" : ""}${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

const ids = readdirSync(CACHE).filter((f) => f.startsWith("activity-")).map((f) => Number(f.slice(9, -5)));
const allRuns: CourseSegment[][] = [];
for (const id of ids) {
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}activity-${id}.json`, "utf8"));
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (pts.length < 50) continue;
    const c = runPipeline(pts);
    if (c.hasTimestamps) allRuns.push(c.segments);
  } catch { /* unreadable cache entry */ }
}

const observations = buildDescentCapObservations(allRuns);
const fit = fitDescentCapCurve(observations);

console.log(`Fitted from ${allRuns.length} cached runs.`);
console.log(`tier=${fit.tier}  bands=${fit.bandCount}  descent=${(fit.totalDescentM / 1000).toFixed(1)} km  steep=${(fit.steepDescentM / 1000).toFixed(1)} km\n`);
console.log("grade band   distance   demonstrated (p95)   default cap   FITTED cap");
for (const o of observations) {
  const binds = fit.bindingGradients.includes(o.gradient);
  console.log(
    `  ${(o.gradient * 100).toFixed(0).padStart(4)}%     ${(o.distanceM / 1000).toFixed(1).padStart(6)} km   ` +
      `${pace(o.speedMs).padStart(11)}/km   ${pace(gradeOnlyMaxDescentSpeedMs(o.gradient)).padStart(8)}/km   ` +
      `${pace(gradeOnlyMaxDescentSpeedMs(o.gradient)).padStart(7)}/km${binds ? "  <-- binds" : ""}`,
  );
}
console.log(`\ndefault: onset ${DEFAULT_DESCENT_CAP_CURVE.onsetSpeedMs.toFixed(2)} m/s, clamp ${DEFAULT_DESCENT_CAP_CURVE.clampSpeedMs.toFixed(2)} m/s`);
console.log(`fitted:  onset ${fit.curve.onsetSpeedMs.toFixed(2)} m/s, clamp ${fit.curve.clampSpeedMs.toFixed(2)} m/s`);

// --- re-predict the reference races -------------------------------------
const applied: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: [{ date: "2026-01-01", value: VO2, source: "manual" as const }],
  durationCurve: "powerLaw", powerLawFraction60Min: 0.799, powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 },
};
const RACES = [
  { id: 15777092101, name: "Askerspurten 10 km", actualS: 42 * 60 + 5, hull: true },
  { id: 14579457702, name: "Ecotrail 80", actualS: 8 * 3600 + 22 * 60 + 31, hull: true },
  { id: 12524841443, name: "Oslo Trail Challenge 55", actualS: 7 * 3600 + 6 * 60 + 1, hull: false },
];
function predict(segments: CourseSegment[], capCurve?: DescentCapCurve) {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(applied);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...applied, lt1Fraction, lt2Fraction });
  const si: SolverInputs = {
    segments, ceilingParams: resolveCeilingParams(applied), bodyMassKg: applied.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: applied.foPeakGPerMin },
    fueling: { intakeGPerH: applied.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(applied),
    walkMaxMs: applied.walkMaxMs, altitudeAdjustment: applied.altitudeAdjustment,
    anaerobicCapacityMin: applied.anaerobicCapacityMin,
    surfaceCostMultipliers: applied.surfaceCostMultipliers ?? undefined,
    descentCapCurve: capCurve,
  };
  const r = findFlatPacedFinishTime(si).result;
  let work = 0;
  for (const g of r.segments) work += g.grossPowerWPerKg * g.timeS;
  return {
    t: r.finishTimeS,
    realized: work / r.finishTimeS / maxAerobicPower(0, si.ceilingParams),
    licensed: Math.min(1, 0.799 * Math.pow(r.finishTimeS / 3600, -0.16)),
  };
}
console.log(`\n${"=".repeat(88)}\nPredictions at VO2max ${VO2} (hull races should land ON actual; others faster than actual)\n`);
console.log("race                       actual     default cap        fitted cap        spent/licensed");
for (const race of RACES) {
  const raw = JSON.parse(readFileSync(`${CACHE}activity-${race.id}.json`, "utf8"));
  const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(pts);
  const sp = `${SURFACE}${race.id}.json`;
  const segments = existsSync(sp)
    ? attachSurfaceData(course.segments, JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[])
    : course.segments;
  const b = predict(segments);
  const a = predict(segments, fit.curve);
  console.log(
    `${(race.name + (race.hull ? " [hull]" : "")).padEnd(26)} ${hms(race.actualS)}  ` +
      `${hms(b.t)} ${(((b.t - race.actualS) / race.actualS) * 100).toFixed(1).padStart(6)}%  ` +
      `${hms(a.t)} ${(((a.t - race.actualS) / race.actualS) * 100).toFixed(1).padStart(6)}%   ` +
      `${(a.realized * 100).toFixed(1)}%/${(a.licensed * 100).toFixed(1)}%`,
  );
}
