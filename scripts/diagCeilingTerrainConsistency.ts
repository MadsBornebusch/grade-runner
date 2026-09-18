// The duration-ceiling envelope is measured from analyzeRun WITHOUT the
// terrain cost multipliers (runFitBatch.ts passes none), but the solver
// predicts WITH them. So the ceiling licenses the power a plain-Minetti
// course would have taken, and the solver then has to buy a more expensive
// course with it -- predicting slow in proportion to how much unpaved
// ground the race has.
//
// Measures the sustained fractions both ways, refits the envelope, and
// re-predicts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import {
  buildDescentCapObservations, fitDescentCapCurve,
  fitDurationCeilingAcrossRaces, type DurationCeilingObservation,
} from "../src/model/pacingFit.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG,
  resolveLt1Lt2Fractions, resolveSubstrateAnchors, type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VO2 = Number(arg("vo2max") ?? 55);
const MULTIPLIERS = { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 } as const;

const CONFIRMED = [
  { id: 15777092101, name: "Askerspurten 10 km" },
  { id: 15573231122, name: "Saksumdal 17" },
  { id: 12524841443, name: "Oslo Trail Challenge 55" },
  { id: 14579457702, name: "Ecotrail 80" },
  { id: 18726525125, name: "Soria Moria 168" },
];
const REFERENCE = [
  { id: 15777092101, name: "Askerspurten 10", actualS: 2525, hull: true },
  { id: 14579457702, name: "Ecotrail 80", actualS: 30151, hull: true },
  { id: 12524841443, name: "OTC 55", actualS: 25561, hull: false },
];
const hms = (s: number) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

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

const inp: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: [{ date: "2026-01-01", value: VO2, source: "manual" as const }],
  durationCurve: "powerLaw", powerLawFraction60Min: 0.799, powerLawExponent: 0.16,
  surfaceCostMultipliers: { ...MULTIPLIERS },
};
const ceilingParams = resolveCeilingParams(inp);
const refMap = maxAerobicPower(0, ceilingParams);

function observe(withTerrain: boolean): DurationCeilingObservation[] {
  const out: DurationCeilingObservation[] = [];
  for (const race of CONFIRMED) {
    const segments = load(race.id);
    if (!segments) continue;
    const analysis = analyzeRun(segments, {
      bodyMassKg: inp.bodyMassKg, ceilingParams,
      fueling: { intakeGPerH: inp.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(inp),
      walkMaxMs: inp.walkMaxMs, altitudeAdjustment: inp.altitudeAdjustment,
      ...(withTerrain ? { surfaceCostMultipliers: { ...MULTIPLIERS } } : {}),
    });
    let weighted = 0, weight = 0;
    for (const seg of analysis.segments) {
      if (seg.paused || seg.timeS <= 0) continue;
      weighted += (seg.grossPowerWPerKg / refMap) * seg.timeS;
      weight += seg.timeS;
    }
    if (weight > 0) out.push({ durationMin: analysis.totalMovingTimeS / 60, sustainedFraction: weighted / weight, name: race.name });
  }
  return out;
}

const without = observe(false);
const withT = observe(true);
console.log("sustained fraction of VO2max, as the fit measures it\n");
console.log("race                       duration   WITHOUT terrain   WITH terrain   change");
for (let i = 0; i < without.length; i++) {
  console.log(
    `${without[i].name!.padEnd(26)} ${(without[i].durationMin / 60).toFixed(2).padStart(6)}h   ` +
      `${(without[i].sustainedFraction * 100).toFixed(1).padStart(13)}%   ${(withT[i].sustainedFraction * 100).toFixed(1).padStart(11)}%   ` +
      `${(((withT[i].sustainedFraction / without[i].sustainedFraction) - 1) * 100).toFixed(1).padStart(5)}%`,
  );
}
const fitA = fitDurationCeilingAcrossRaces(without, { fraction60Min: 0.81, exponent: 0.16 });
const fitB = fitDurationCeilingAcrossRaces(withT, { fraction60Min: 0.81, exponent: 0.16 });
console.log(`\nrefit envelope  WITHOUT terrain: f60 ${fitA.fraction60Min.toFixed(4)}, exp ${fitA.exponent.toFixed(4)} (${fitA.tier})`);
console.log(`refit envelope  WITH terrain:    f60 ${fitB.fraction60Min.toFixed(4)}, exp ${fitB.exponent.toFixed(4)} (${fitB.tier})`);

const all: CourseSegment[][] = [];
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("activity-"))) {
  const s = load(Number(f.slice(9, -5)));
  if (s) all.push(s);
}
const capCurve = fitDescentCapCurve(buildDescentCapObservations(all)).curve;

function predict(segments: CourseSegment[], f60: number, exponent: number) {
  const use: FormInputs = { ...inp, powerLawFraction60Min: f60, powerLawExponent: exponent };
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(use);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...use, lt1Fraction, lt2Fraction });
  const si: SolverInputs = {
    segments, ceilingParams: resolveCeilingParams(use), bodyMassKg: use.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: use.foPeakGPerMin },
    fueling: { intakeGPerH: use.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(use),
    walkMaxMs: use.walkMaxMs, altitudeAdjustment: use.altitudeAdjustment,
    anaerobicCapacityMin: use.anaerobicCapacityMin, surfaceCostMultipliers: { ...MULTIPLIERS },
    descentCapCurve: capCurve,
  };
  return findFlatPacedFinishTime(si).result.finishTimeS;
}
console.log(`\n${"=".repeat(84)}`);
console.log("race                  actual       ceiling as-is        ceiling measured with terrain");
for (const race of REFERENCE) {
  const segs = load(race.id);
  if (!segs) continue;
  const a = predict(segs, fitA.fraction60Min, fitA.exponent);
  const b = predict(segs, fitB.fraction60Min, fitB.exponent);
  console.log(
    `${(race.name + (race.hull ? " [hull]" : "")).padEnd(21)} ${hms(race.actualS)}  ` +
      `${hms(a)} ${(((a - race.actualS) / race.actualS) * 100).toFixed(1).padStart(6)}%      ` +
      `${hms(b)} ${(((b - race.actualS) / race.actualS) * 100).toFixed(1).padStart(6)}%`,
  );
}
