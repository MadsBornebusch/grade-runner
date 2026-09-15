// Offline reproduction of a race prediction, WITH surface data attached
// from .surface-cache/ -- so the terrain cost multipliers actually bite,
// which earlier diagnostics in this repo silently skipped by loading the
// raw course instead.
//
// Prints, per race: the surface mix, the prediction with the athlete's
// applied parameters, and a one-at-a-time decomposition of what each cost
// term is worth. Also reports licensed-vs-realized aerobic power, which is
// the profile-independent check.
//
// bodyMassKg / VO2max / LT1 / LT2 are DEFAULT_FORM_INPUTS, not the
// athlete's saved profile -- pass --vo2max= and --mass= to override.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint, type SurfaceCategory } from "../src/gpx/pipeline.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
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

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

const RACES: { id: number; name: string; actualS: number }[] = [
  { id: 15777092101, name: "Askerspurten 10 km", actualS: 42 * 60 + 5 },
  { id: 14579457702, name: "Ecotrail 80", actualS: 8 * 3600 + 22 * 60 + 31 },
  { id: 12524841443, name: "Oslo Trail Challenge 55 km", actualS: 7 * 3600 + 6 * 60 + 1 },
];

// The athlete's currently-applied fit.
const applied: FormInputs = {
  ...DEFAULT_FORM_INPUTS,
  vo2MaxHistory: arg("vo2max")
    ? [{ value: Number(arg("vo2max")), date: "2026-01-01", source: "manual" as const }]
    : DEFAULT_FORM_INPUTS.vo2MaxHistory,
  bodyMassKg: arg("mass") ? Number(arg("mass")) : DEFAULT_FORM_INPUTS.bodyMassKg,
  durationCurve: "powerLaw",
  powerLawFraction60Min: 0.799,
  powerLawExponent: 0.16,
  surfaceCostMultipliers: { gravel: 1.06, dirt: 1.03, compacted: 1.05, path: 1.17 },
};

const hms = (s: number) => {
  const t = Math.round(Math.abs(s));
  return `${s < 0 ? "-" : ""}${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function build(segments: CourseSegment[], inputs: FormInputs): SolverInputs {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(inputs);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...inputs, lt1Fraction, lt2Fraction });
  return {
    segments,
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
    descentPacingInCeiling: inputs.descentPacingCurve ? false : inputs.durationCurve === "powerLaw",
    // A curve of f0 = fInf = 10 lifts the cap far above any achievable
    // speed: the only way to ask what the GRADE-ONLY descent cap (kept
    // deliberately, as a biomechanical limit) is still costing.
    descentPacingCurve: inputs.descentPacingCurve ?? undefined,
  };
}

function run(segments: CourseSegment[], inputs: FormInputs) {
  const si = build(segments, inputs);
  const r = findFlatPacedFinishTime(si).result;
  let work = 0;
  for (const seg of r.segments) work += seg.grossPowerWPerKg * seg.timeS;
  const realized = work / r.finishTimeS / maxAerobicPower(0, si.ceilingParams);
  const licensed = Math.min(1, inputs.powerLawFraction60Min * Math.pow(r.finishTimeS / 3600, -inputs.powerLawExponent));
  return { t: r.finishTimeS, realized, licensed };
}

for (const race of RACES) {
  const raw = JSON.parse(readFileSync(`${CACHE}activity-${race.id}.json`, "utf8"));
  const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  const course = runPipeline(pts);
  const sp = `${SURFACE}${race.id}.json`;
  if (!existsSync(sp)) { console.log(`\n${race.name}: NO SURFACE CACHE -- skipping\n`); continue; }
  const edges = JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[];
  const segments = attachSurfaceData(course.segments, edges);

  const byCat = new Map<string, number>();
  let tagged = 0, totalM = 0;
  for (const s of segments) {
    totalM += s.distance3D;
    const c: SurfaceCategory | "untagged" = s.surfaceCategory ?? "untagged";
    if (s.surfaceCategory) tagged += s.distance3D;
    byCat.set(c, (byCat.get(c) ?? 0) + s.distance3D);
  }

  console.log(`\n${"=".repeat(74)}\n${race.name} -- ${(totalM / 1000).toFixed(1)} km, actual ${hms(race.actualS)}`);
  console.log(`surface tagged on ${((tagged / totalM) * 100).toFixed(0)}% of distance:`);
  for (const [c, m] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    const mult = (applied.surfaceCostMultipliers as any)?.[c];
    console.log(`   ${c.padEnd(10)} ${(m / 1000).toFixed(1).padStart(6)} km  ${((m / totalM) * 100).toFixed(0).padStart(3)}%${mult ? `   x${mult}` : ""}`);
  }

  const base = run(segments, applied);
  const noSurface = run(segments, { ...applied, surfaceCostMultipliers: null });
  const noPath = run(segments, { ...applied, surfaceCostMultipliers: { ...applied.surfaceCostMultipliers!, path: 1 } });
  const noDescentCap = run(segments, { ...applied, descentPacingCurve: { f0: 10, fInf: 10, tauKm: 41 } });
  const neither = run(segments, {
    ...applied, surfaceCostMultipliers: null, descentPacingCurve: { f0: 10, fInf: 10, tauKm: 41 },
  });
  const expo = run(segments, { ...applied, durationCurve: "exponential", f0: 0.94, fInf: 0.66, tauMin: 220 });

  const line = (label: string, r: ReturnType<typeof run>) =>
    console.log(
      `   ${label.padEnd(34)} ${hms(r.t).padStart(9)}  ${(((r.t - race.actualS) / race.actualS) * 100).toFixed(1).padStart(6)}%   ` +
        `spent ${(r.realized * 100).toFixed(1)}% / licensed ${(r.licensed * 100).toFixed(1)}%`,
    );
  console.log(`\n   ${"prediction".padEnd(34)} ${"finish".padStart(9)}  ${"err".padStart(6)}`);
  line("as applied", base);
  line("  ...path 1.17x -> 1.00x", noPath);
  line("  ...no terrain multipliers at all", noSurface);
  line("  ...grade-only descent cap removed", noDescentCap);
  line("  ...no terrain AND no descent cap", neither);
  line("  ...exponential ceiling instead", expo);
}

