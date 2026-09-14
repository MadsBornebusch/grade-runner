// Before/after for the descentPacingInCeiling fix: does dropping the
// distance-scaled descent PACING multiplier (when the duration-ceiling
// envelope owns descent behaviour) improve predictions across this
// athlete's races, or just move the error somewhere else?
//
// Same limitation predictARaces.ts documents: bodyMassKg/VO2max/LT1/LT2
// come from DEFAULT_FORM_INPUTS, not the athlete's saved profile, so
// absolute errors carry a constant offset. The BEFORE/AFTER delta on each
// race is the meaningful quantity.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import {
  DEFAULT_FORM_INPUTS,
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
// Structured/deliberately-easy sessions that merely have a name and real
// elevation -- same exclusions descentSpeedVsDistance.ts already documents.
const NOT_A_RACE = new Set(["Evening Intervals", "2.5 km loop every hour", "Langt Og Langsomt"]);

// The athlete's currently-applied fit (the duration-ceiling envelope is
// live, so descentPacingInCeiling is what this run is testing).
const applied: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  durationCurve: "powerLaw",
  powerLawFraction60Min: 0.799,
  powerLawExponent: 0.16,
};

const hms = (s: number) => {
  const t = Math.round(Math.abs(s));
  return `${s < 0 ? "-" : ""}${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

interface Meta { stravaId: number; name: string; distanceKm: number; elevationGainM: number; movingTimeS?: number; durationS?: number }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Meta[];
const cached = new Set(
  readdirSync(CACHE).filter((f) => f.startsWith("activity-")).map((f) => Number(f.slice(9, -5))),
);

const races = activities
  .filter((a) => cached.has(a.stravaId))
  .filter((a) => !NOT_A_RACE.has(a.name))
  .filter((a) => a.distanceKm >= 8 && a.elevationGainM >= 100)
  .filter((a) => !/^(early morning|morning|lunch|afternoon|evening|late night|night) (run|trail run|hike|walk)$/i.test(a.name))
  .sort((a, b) => a.distanceKm - b.distanceKm);

function predict(course: ReturnType<typeof runPipeline>, descentPacingInCeiling: boolean) {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(applied);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...applied, lt1Fraction, lt2Fraction });
  const si: SolverInputs = {
    segments: course.segments,
    ceilingParams: resolveCeilingParams(applied),
    bodyMassKg: applied.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: applied.foPeakGPerMin },
    fueling: { intakeGPerH: applied.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(applied),
    walkMaxMs: applied.walkMaxMs,
    forceWalkAboveGrade: applied.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: applied.altitudeAdjustment,
    anaerobicCapacityMin: applied.anaerobicCapacityMin,
    descentPacingInCeiling,
  };
  const r = findFlatPacedFinishTime(si).result;
  // The quantity the bug is about, and the only one free of the unknown
  // athlete profile: of the aerobic power the ceiling LICENSES at the
  // duration it predicts, how much does the solver actually SPEND? A
  // ceiling the solver cannot spend is not a ceiling.
  let work = 0;
  for (const seg of r.segments) work += seg.grossPowerWPerKg * seg.timeS;
  const realized = work / r.finishTimeS / maxAerobicPower(0, si.ceilingParams);
  const licensed = Math.min(1, applied.powerLawFraction60Min * Math.pow(r.finishTimeS / 3600, -applied.powerLawExponent));
  return { t: r.finishTimeS, realized, licensed };
}

// Two views. The SHORTFALL is the decisive one: it is what the bug is
// about and it does not depend on the athlete profile this script lacks.
// The finish times are shown too, but note the ceiling prediction should
// only EQUAL actual for the races the hull rests on (Askerspurten and
// Ecotrail); for every other race the ceiling licenses more than the
// athlete actually spent, so a correct ceiling comes out FASTER than the
// real finish. Judging this table by |predicted - actual| rewards exactly
// the double-count being removed.
console.log("race                              km   actual     | BEFORE spent/lic  short   finish     | AFTER spent/lic  short   finish");
console.log("-".repeat(112));
let nB = 0, nA = 0, count = 0;
for (const a of races) {
  let course;
  try {
    const raw = JSON.parse(readFileSync(`${CACHE}activity-${a.stravaId}.json`, "utf8"));
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    if (pts.length < 50) continue;
    course = runPipeline(pts);
  } catch { continue; }
  const actual = a.movingTimeS ?? a.durationS;
  if (!actual || actual < 1800) continue;

  const before = predict(course, false);
  const after = predict(course, true);
  const sB = before.licensed - before.realized, sA = after.licensed - after.realized;
  nB += Math.abs(sB); nA += Math.abs(sA); count++;
  console.log(
    `${a.name.slice(0, 30).padEnd(31)} ${a.distanceKm.toFixed(0).padStart(4)} ${hms(actual).padStart(9)} | ` +
      `${(before.realized * 100).toFixed(1).padStart(5)}%/${(before.licensed * 100).toFixed(1)}% ${(sB * 100).toFixed(1).padStart(5)}pp ${hms(before.t)} ${(((before.t - actual) / actual) * 100).toFixed(0).padStart(4)}% | ` +
      `${(after.realized * 100).toFixed(1).padStart(5)}%/${(after.licensed * 100).toFixed(1)}% ${(sA * 100).toFixed(1).padStart(5)}pp ${hms(after.t)} ${(((after.t - actual) / actual) * 100).toFixed(0).padStart(4)}%`,
  );
}
console.log("-".repeat(112));
console.log(`mean |shortfall| over ${count} races:  BEFORE ${((nB / count) * 100).toFixed(2)}pp   AFTER ${((nA / count) * 100).toFixed(2)}pp`);
