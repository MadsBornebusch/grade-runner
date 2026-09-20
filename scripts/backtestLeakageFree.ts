// Leakage-free backtest: for each target race, refit the whole athlete
// model using ONLY runs recorded BEFORE that race, then predict it.
//
// Mirrors runFitBatch's order and gating, so a tier that would have fallen
// back to defaults on the day falls back here too -- that is the point.
// Nothing about the target race (its result, its own GPS, its date's own
// data) enters its own fit.
//
// VO2max is the one input a script cannot read (it lives in localStorage).
// Predictions are near-invariant to it -- the envelope measures
// power/maxAerobicPower and the curve is fitted through that, so the two
// cancel -- and --vo2max= is provided to demonstrate that rather than to
// tune it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type CourseSegment, type GpxPoint } from "../src/gpx/pipeline.ts";
import { splitAtTransitGaps } from "../src/gpx/transitGap.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { maxAerobicPower, type CeilingParams } from "../src/model/ceiling.ts";
import { buildSegmentLibrary } from "../src/model/segmentLibrary.ts";
import {
  buildEffortTrendPoints, buildDescentCapObservations, fitDescentCapCurve,
  fitDurationCeilingAcrossRaces, fitAnaerobicCapacityMin,
  fitSurfaceCostMultipliersFromIntensity, type DurationCeilingObservation,
} from "../src/model/pacingFit.ts";
import { fitHrToPowerCalibrationAcrossRaces } from "../src/model/hrCalibration.ts";
import { fitPacingMarginAcrossRaces, predictMarginTheta, predictBestDemonstratedTheta } from "../src/model/pacingMarginFit.ts";
import { findFlatPacedFinishTime, type SolverInputs } from "../src/model/solver.ts";
import {
  DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG,
  resolveLt1Lt2Fractions, resolveSubstrateAnchors, type FormInputs,
} from "../src/ui/formInputs.ts";

const CACHE = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE = fileURLToPath(new URL("../.surface-cache/", import.meta.url));
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const VO2 = Number(arg("vo2max") ?? 55);

/** The athlete's confirmed races (Settings -> Confirm your races). Backyard
 * ultra is deliberately absent: a stop-start loop format is not a
 * continuous effort, and the athlete leaves it unchecked. */
const CONFIRMED = new Set([12347317200, 12524841443, 14579457702, 15714210750, 15777092101, 18726525125]);

const TARGETS = [
  { id: 14579457702, name: "Ecotrail 80", date: "2025-05-24", actualS: 8 * 3600 + 22 * 60 + 31 },
  { id: 15777092101, name: "Askerspurten 10 km", date: "2025-09-11", actualS: 42 * 60 + 5 },
  { id: 18726525125, name: "Soria Moria 171 km", date: "2026-05-30", actualS: 24 * 3600 + 15 * 60 + 2 },
];

interface Meta { stravaId: number; name: string; date: string }
const activities = JSON.parse(readFileSync(`${CACHE}activities.json`, "utf8")) as Meta[];
const dateById = new Map(activities.map((a) => [a.stravaId, a.date]));
const nameById = new Map(activities.map((a) => [a.stravaId, a.name]));
const cachedIds = readdirSync(CACHE).filter((f) => f.startsWith("activity-")).map((f) => Number(f.slice(9, -5)));

function loadSegments(id: number): CourseSegment[] | null {
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

const hms = (s: number) => {
  const t = Math.round(Math.abs(s));
  return `${s < 0 ? "-" : ""}${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

console.log(`Leakage-free backtest at VO2max ${VO2}. Each race is predicted from runs recorded strictly before it.\n`);

for (const target of TARGETS) {
  const cutoff = target.date;
  const pool = cachedIds.filter((id) => {
    const d = dateById.get(id);
    return d !== undefined && d.slice(0, 10) < cutoff;
  });

  // ---- build the training library, exactly as runFitBatch does ----------
  const libraryInputs: { runId: string; segments: CourseSegment[] }[] = [];
  const raceSegments: { id: number; segments: CourseSegment[] }[] = [];
  for (const id of pool) {
    const raw = (() => { try { return JSON.parse(readFileSync(`${CACHE}activity-${id}.json`, "utf8")); } catch { return null; } })();
    if (!raw) continue;
    const pts: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
    const legs = splitAtTransitGaps(pts);
    const sp = `${SURFACE}${id}.json`;
    const edges = legs.length === 1 && existsSync(sp) ? (JSON.parse(readFileSync(sp, "utf8")) as ValhallaSurfaceEdge[]) : null;
    legs.forEach((leg, i) => {
      const c = runPipeline(leg);
      if (!c.hasTimestamps) return;
      const segs = edges ? attachSurfaceData(c.segments, edges) : c.segments;
      libraryInputs.push({ runId: legs.length > 1 ? `${id}-leg${i + 1}` : String(id), segments: segs });
      if (CONFIRMED.has(id) && legs.length === 1) raceSegments.push({ id, segments: segs });
    });
  }

  const base: FormInputs = {
    ...DEFAULT_FORM_INPUTS,
    vo2MaxHistory: [{ date: "2020-01-01", value: VO2, source: "manual" as const }],
  };
  const ceilingParams: CeilingParams = resolveCeilingParams(base);

  // 1. terrain cost, from the whole pre-race library
  const surfaceFit = fitSurfaceCostMultipliersFromIntensity(
    buildSegmentLibrary(libraryInputs, { bodyMassKg: base.bodyMassKg, ceilingParams }),
  );
  const multipliers = surfaceFit?.surfaceCostMultipliers;

  // 2. descent cap, from the whole pre-race library
  const capFit = fitDescentCapCurve(buildDescentCapObservations(libraryInputs.map((l) => l.segments)));

  // 3. per-race analysis, measured through the terrain cost just fitted --
  //    the fit's cost basis must match the solver's (analyzeOptionsFor)
  const analyzeOpts = {
    bodyMassKg: base.bodyMassKg, ceilingParams,
    fueling: { intakeGPerH: base.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(base),
    walkMaxMs: base.walkMaxMs, altitudeAdjustment: base.altitudeAdjustment,
    ...(multipliers ? { surfaceCostMultipliers: multipliers } : {}),
  };
  const refMap = maxAerobicPower(0, ceilingParams);
  const obs: DurationCeilingObservation[] = [];
  const trendPoints: ReturnType<typeof buildEffortTrendPoints>[] = [];
  const raceNames: string[] = [];
  for (const r of raceSegments) {
    const analysis = analyzeRun(r.segments, analyzeOpts);
    if (!(analysis.totalMovingTimeS > 0)) continue;
    let weighted = 0, weight = 0;
    for (const seg of analysis.segments) {
      if (seg.paused || seg.timeS <= 0) continue;
      weighted += (seg.grossPowerWPerKg / refMap) * seg.timeS;
      weight += seg.timeS;
    }
    if (weight <= 0) continue;
    obs.push({ durationMin: analysis.totalMovingTimeS / 60, sustainedFraction: weighted / weight, name: nameById.get(r.id) });
    trendPoints.push(buildEffortTrendPoints(r.segments, analysis.segments, base.altitudeAdjustment));
    raceNames.push(nameById.get(r.id) ?? String(r.id));
  }

  // 4. duration ceiling + anaerobic capacity
  const ceilingFit = fitDurationCeilingAcrossRaces(obs, {
    fraction60Min: base.powerLawFraction60Min, exponent: base.powerLawExponent,
  });
  const anaerobic = fitAnaerobicCapacityMin(obs, ceilingFit, base.anaerobicCapacityMin);

  // 5. HR calibration + pacing margin (what drives "Chosen pacing")
  const allTrend = libraryInputs.map((l) => {
    const a = analyzeRun(l.segments, analyzeOpts);
    return buildEffortTrendPoints(l.segments, a.segments, base.altitudeAdjustment);
  });
  const hrFit = fitHrToPowerCalibrationAcrossRaces(allTrend);
  const marginFit = hrFit ? fitPacingMarginAcrossRaces(trendPoints, raceNames, hrFit, ceilingParams) : null;

  // ---- predict the target -----------------------------------------------
  const applied: FormInputs = {
    ...base,
    powerLawFraction60Min: ceilingFit.fraction60Min,
    powerLawExponent: ceilingFit.exponent,
    anaerobicCapacityMin: anaerobic.identifiable ? anaerobic.anaerobicCapacityMin : base.anaerobicCapacityMin,
    surfaceCostMultipliers: multipliers ?? null,
    descentCapCurve: capFit.tier !== "defaults" ? capFit.curve : null,
  };
  const segments = loadSegments(target.id);
  if (!segments) { console.log(`${target.name}: no cached GPS\n`); continue; }
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(applied);
  const { x0, k, intensityIsAbsolutePower } = resolveSubstrateAnchors({ ...applied, lt1Fraction, lt2Fraction });
  const si: SolverInputs = {
    segments, ceilingParams: resolveCeilingParams(applied), bodyMassKg: applied.bodyMassKg,
    substrateParams: { x0, k, intensityIsAbsolutePower, foPeakGPerMin: applied.foPeakGPerMin },
    fueling: { intakeGPerH: applied.intakeGPerH }, glycogenStoreG: resolveGlycogenStoreG(applied),
    walkMaxMs: applied.walkMaxMs, altitudeAdjustment: applied.altitudeAdjustment,
    anaerobicCapacityMin: applied.anaerobicCapacityMin,
    surfaceCostMultipliers: applied.surfaceCostMultipliers ?? undefined,
    descentCapCurve: applied.descentCapCurve ?? undefined,
  };
  const ceilingPred = findFlatPacedFinishTime(si).result;
  const chosen = marginFit ? findFlatPacedFinishTime(si, { marginCurve: (h) => predictMarginTheta(h, marginFit) }).result : null;
  const best = marginFit ? findFlatPacedFinishTime(si, { marginCurve: (h) => predictBestDemonstratedTheta(h, marginFit) }).result : null;

  const err = (t: number) => `${(((t - target.actualS) / target.actualS) * 100).toFixed(1).padStart(6)}%`;
  console.log(`${"=".repeat(78)}\n${target.name}  (${target.date})   actual ${hms(target.actualS)}`);
  console.log(`  training pool: ${pool.length} runs, ${obs.length} confirmed races before this date`);
  console.log(`  duration ceiling: tier=${ceilingFit.tier}  f60=${ceilingFit.fraction60Min.toFixed(4)} exp=${ceilingFit.exponent.toFixed(4)}` +
    (ceilingFit.bindingRaceNames.length ? `  rests on ${ceilingFit.bindingRaceNames.join(" + ")}` : ""));
  console.log(`  descent cap: tier=${capFit.tier}  onset ${capFit.curve.onsetSpeedMs.toFixed(2)} m/s, clamp ${capFit.curve.clampSpeedMs.toFixed(2)} m/s`);
  console.log(`  terrain: ${multipliers ? Object.entries(multipliers).map(([c, m]) => `${c} ${m!.toFixed(2)}x`).join(", ") : "not fit"}`);
  console.log(`  pacing margin: ${marginFit ? `f_inf ${marginFit.marginFInf.toFixed(2)}, tau ${marginFit.marginTauHours.toFixed(1)}h (${raceNames.length} races)` : "not fit -- too few confirmed races"}`);
  console.log(`\n  Theoretical ceiling  ${hms(ceilingPred.finishTimeS)}  ${err(ceilingPred.finishTimeS)}`);
  if (chosen) console.log(`  Chosen pacing        ${hms(chosen.finishTimeS)}  ${err(chosen.finishTimeS)}   <-- the number the athlete would have seen`);
  if (best) console.log(`  Best demonstrated    ${hms(best.finishTimeS)}  ${err(best.finishTimeS)}`);
  console.log();
}
