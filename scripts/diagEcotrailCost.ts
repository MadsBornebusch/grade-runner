// One-off: the fitted duration ceiling passes through Ecotrail 80 at the
// fraction the athlete actually held there, yet the app predicts ~9:51
// against an actual 8:25. That puts the error on the cost side, not the
// ceiling. This attributes it.
//
// Absolute times here are NOT the athlete's -- bodyMassKg/VO2max/LT2 come
// from DEFAULT_FORM_INPUTS (same limitation predictARaces.ts documents).
// Every claim below is a RATIO between two runs of this same script, which
// is profile-independent to first order.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { maxDescentSpeedMs, DEFAULT_DESCENT_PACING_CURVE, descentPacingMultiplier } from "../src/model/minetti.ts";
import { maxAerobicPower } from "../src/model/ceiling.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS,
  resolveCeilingParams,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveSubstrateAnchors,
  type FormInputs,
} from "../src/ui/formInputs.ts";

const ECOTRAIL_ID = 14579457702;
const ACTUAL_S = 8 * 3600 + 25 * 60;
const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`../.strava-cache/activity-${ECOTRAIL_ID}.json`, import.meta.url)), "utf8"));
const points: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
const course = runPipeline(points);
const totalKm = course.totalDistance3D / 1000;

const hms = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// The athlete's real, currently-applied fit.
const applied: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  durationCurve: "powerLaw",
  powerLawFraction60Min: 0.799,
  powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.04, dirt: 1.04, compacted: 1.05, path: 1.19 },
  descentPacingCurve: DEFAULT_DESCENT_PACING_CURVE,
};

function build(inputs: FormInputs): SolverInputs {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(inputs);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...inputs, lt1Fraction, lt2Fraction });
  return {
    segments: course.segments,
    ceilingParams: resolveCeilingParams(inputs),
    bodyMassKg: inputs.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: inputs.foPeakGPerMin },
    fueling: { intakeGPerH: inputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG(inputs),
    walkMaxMs: inputs.walkMaxMs,
    forceWalkAboveGrade: inputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: inputs.altitudeAdjustment,
    anaerobicCapacityMin: inputs.anaerobicCapacityMin,
    surfaceCostMultipliers: inputs.surfaceCostMultipliers ?? undefined,
    descentPacingCurve: inputs.descentPacingCurve ?? undefined,
  };
}

const runs: { label: string; t: number }[] = [];
function go(label: string, inputs: FormInputs) {
  const t = findFlatPacedFinishTime(build(inputs)).result.finishTimeS;
  runs.push({ label, t });
  return t;
}

console.log(`Ecotrail 80: ${totalKm.toFixed(1)} km, ${Math.round(course.totalElevationGain)} m gain, actual ${hms(ACTUAL_S)}`);
console.log(`descent pacing multiplier at ${totalKm.toFixed(0)} km = ${descentPacingMultiplier(totalKm).toFixed(3)}\n`);

const base = go("as applied", applied);
// NOTE: descentPacingCurve: null does NOT disable the multiplier -- the
// solver always passes totalDistanceKm and maxDescentSpeedMs falls back to
// DEFAULT_DESCENT_PACING_CURVE. An identity curve is the only way off.
const IDENTITY = { f0: 1, fInf: 1, tauKm: 41 };
go("with an identity descent multiplier (1.0x)", { ...applied, descentPacingCurve: IDENTITY });
// f0 = fInf = 10 lifts the cap far above any achievable speed, which is
// the only way to ask "what does the descent cap cost in total".
const UNCAPPED = { f0: 10, fInf: 10, tauKm: 41 };
go("with the descent cap effectively removed", { ...applied, descentPacingCurve: UNCAPPED });
go("without terrain cost multipliers", { ...applied, surfaceCostMultipliers: null });
go("with the exponential ceiling the panel showed", {
  ...applied, durationCurve: "exponential", f0: 0.94, fInf: 0.66, tauMin: 220,
});

for (const { label, t } of runs) {
  console.log(`${label.padEnd(42)} ${hms(t)}   ${((t / base - 1) * 100).toFixed(1).padStart(6)}% vs as-applied`);
}

// How much of the course the solver holds at the descent cap rather than
// at the power target -- "braking". That distance is spending less than
// the ceiling allows, which is what stretches the finish time.
const res = findFlatPacedFinishTime(build(applied)).result;
let brakeM = 0, brakeS = 0, descM = 0;
for (let i = 0; i < res.segments.length; i++) {
  const seg = course.segments[i];
  const sim = res.segments[i];
  if (!seg || !sim || seg.gradient >= 0) continue;
  descM += seg.distance3D;
  const cap = maxDescentSpeedMs(seg.gradient, totalKm, DEFAULT_DESCENT_PACING_CURVE);
  if (Number.isFinite(cap) && Math.abs(sim.speedMs - cap) / cap < 0.005) {
    brakeM += seg.distance3D;
    brakeS += sim.timeS ?? 0;
  }
}
console.log(`\ndescent distance ${(descM / 1000).toFixed(1)} km of ${totalKm.toFixed(1)} km`);
console.log(`held AT the descent cap (braking): ${(brakeM / 1000).toFixed(1)} km, ${hms(brakeS)} (${((brakeS / base) * 100).toFixed(0)}% of the race)`);

// The decisive check. The ceiling fit measures a fraction of max aerobic
// power AVERAGED OVER THE WHOLE RACE, from the athlete's actual GPS trace
// -- descents included, run at whatever speed he actually ran them. If the
// solver then holds descents below the power target, its realized average
// power comes out BELOW the very fraction the ceiling licensed, and the
// finish time stretches to compensate. That would be a double-count: the
// descent behaviour is already inside the 57.8%.
function realizedFraction(inputs: FormInputs) {
  const si = build(inputs);
  const r = findFlatPacedFinishTime(si).result;
  let work = 0;
  for (const seg of r.segments) work += seg.grossPowerWPerKg * seg.timeS;
  const meanPower = work / r.finishTimeS;
  const map = maxAerobicPower(0, si.ceilingParams);
  return { meanPower, map, frac: meanPower / map, t: r.finishTimeS };
}
{
  const a = realizedFraction(applied);
  const i = realizedFraction({ ...applied, descentPacingCurve: IDENTITY });
  const u = realizedFraction({ ...applied, descentPacingCurve: UNCAPPED });
  const allowed = 0.799 * Math.pow(a.t / 60 / 60, -0.16);
  console.log(`\nceiling ALLOWS at the predicted ${hms(a.t)}: ${(allowed * 100).toFixed(1)}% of max aerobic power`);
  console.log(`solver actually SPENDS (as applied):        ${(a.frac * 100).toFixed(1)}%`);
  console.log(`solver actually SPENDS (multiplier 1.0x):   ${(i.frac * 100).toFixed(1)}%  -> ${hms(i.t)}`);
  console.log(`solver actually SPENDS (descent uncapped):  ${(u.frac * 100).toFixed(1)}%  -> ${hms(u.t)}`);
  console.log(`athlete's MEASURED fraction on this race:   57.8%`);
}

// What cost inflation would explain the reported error, given the ceiling's
// own feedback: T ~ cost^(1/(1-b)).
const b = 0.16;
const ratio = (9 * 3600 + 51 * 60 + 13) / ACTUAL_S;
console.log(`
FINDING: the ceiling licenses 55.1% but the solver only spends 49.4%. The
shortfall is the descent cap holding descents below the power target. The
ceiling fit's own sustainedFraction (runFitBatch.ts) is a time-weighted
average of grossPowerWPerKg over the athlete's ACTUAL trace, so his descent
pacing is already inside that number -- capping descents again in the solver
subtracts it twice. That is why the envelope "rests on" Ecotrail and still
predicts it slow: a binding race should come back at its own measured time.
`);
console.log(`\nreported 9:51:13 is ${((ratio - 1) * 100).toFixed(1)}% over actual`);
console.log(`with the ceiling's own feedback (T ~ cost^(1/(1-${b}))), that implies the cost model is ${(((ratio ** (1 - b)) - 1) * 100).toFixed(1)}% too expensive on this course`);
