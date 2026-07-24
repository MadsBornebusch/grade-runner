// PLAN.md §14 Plan B, tau/fInf-fix follow-up: the joint fit now correctly
// identifies Ecotrail 80 and Soria Moria as the only two races informing
// tau/fInf, and lands on a surprisingly high fInf (~0.74) -- ruled out
// VO2max scale error (the fit is mathematically invariant to VO2max: it
// only rescales the whole effort-fraction series by a constant, which
// can't change which (fInf, tau) minimizes its slope). The remaining
// candidate: modelled power is pace-derived, not a real effort signal,
// and stays close to flat in these two races for a reason unrelated to
// true physiological fatigue. This checks the one truly independent
// signal available -- heart rate -- against modelled power within each
// race: does HR show a rising trend (classic cardiac drift / fatigue)
// while modelled power/effort-fraction stays flat?
//
// Usage: npx tsx scripts/compareHrVsModelledPower.ts [--bodyMassKg=85] [--vo2Max=54]

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, type GpxPoint } from "../src/gpx/pipeline.ts";
import { analyzeRun } from "../src/model/analysis.ts";
import { ceilingPower, type CeilingParams } from "../src/model/ceiling.ts";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "../src/model/surfaceExposure.ts";
import { buildEffortTrendPoints, trimForPacingFit, type EffortTrendPoint } from "../src/model/pacingFit.ts";
import { DEFAULT_FORM_INPUTS, resolveCeilingParams, resolveGlycogenStoreG } from "../src/ui/formInputs.ts";
import { arg } from "./stravaScriptHelpers.ts";

const BODY_MASS_KG = parseFloat(arg("bodyMassKg", "85"));
const VO2_MAX = parseFloat(arg("vo2Max", "54"));
// The joint fit's own answer on this athlete's data (2-race informative
// set, Soria Moria excluded) -- see PLAN.md §14.
const FITTED_TAU_MIN = parseFloat(arg("tauMin", "317"));
const FITTED_FINF = parseFloat(arg("fInf", "0.737"));
const BIN_MINUTES = parseFloat(arg("binMinutes", "30"));

const CACHE_DIR = fileURLToPath(new URL("../.strava-cache/", import.meta.url));
const SURFACE_CACHE_DIR = fileURLToPath(new URL("../.surface-cache/", import.meta.url));

const RACES: { id: string; label: string }[] = [
  { id: "14579457702", label: "Ecotrail 80" },
  { id: "18726525125", label: "Soria Moria" },
];

function loadCachedActivity(id: string) {
  const raw = JSON.parse(readFileSync(`${CACHE_DIR}activity-${id}.json`, "utf8"));
  const points: GpxPoint[] = raw.points.map((p: any) => ({ ...p, time: p.time ? new Date(p.time) : null }));
  return { name: raw.name as string, points };
}

function loadEdges(id: string): ValhallaSurfaceEdge[] {
  const path = `${SURFACE_CACHE_DIR}${id}.json`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/** Simple unweighted linear regression slope of y vs x (hours), for
 * comparing raw HR's own trend against the effort-fraction trend --
 * deliberately not reusing computeFadeTrend's duration-weighted/peak-
 * binned machinery here, since the goal is a plain, easy-to-eyeball
 * bin-by-bin table, not a replica of the fit itself. */
function linregSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

function main() {
  const formInputs = DEFAULT_FORM_INPUTS;
  const baseCeilingParams: CeilingParams = { ...resolveCeilingParams(formInputs), vo2MaxMlPerKgPerMin: VO2_MAX };
  const fittedParams: CeilingParams = { ...baseCeilingParams, tauMin: FITTED_TAU_MIN, fInf: FITTED_FINF };
  const commonInputs = {
    bodyMassKg: BODY_MASS_KG,
    fueling: { intakeGPerH: formInputs.intakeGPerH },
    glycogenStoreG: resolveGlycogenStoreG({ ...formInputs, bodyMassKg: BODY_MASS_KG }),
    walkMaxMs: formInputs.walkMaxMs,
    forceWalkAboveGrade: formInputs.forceWalkAboveGrade ?? undefined,
    altitudeAdjustment: formInputs.altitudeAdjustment,
  };

  for (const { id, label } of RACES) {
    const { name, points } = loadCachedActivity(id);
    const edges = loadEdges(id);
    const course = runPipeline(points);
    const segments = attachSurfaceData(course.segments, edges);
    const analysis = analyzeRun(segments, { ...commonInputs, ceilingParams: baseCeilingParams });
    const effortTrendPoints = buildEffortTrendPoints(segments, analysis.segments, formInputs.altitudeAdjustment);
    const trimmed = trimForPacingFit(effortTrendPoints);

    const withHr = trimmed.filter((p): p is EffortTrendPoint & { heartRateBpm: number } => p.heartRateBpm !== undefined);
    console.log(`\n=== ${label} (${name}) ===`);
    console.log(`${trimmed.length} trimmed segments, ${withHr.length} with heart rate (${((withHr.length / trimmed.length) * 100).toFixed(0)}%)`);
    if (withHr.length === 0) {
      console.log("No heart rate data -- skipping");
      continue;
    }

    const totalHours = trimmed[trimmed.length - 1].tHours;
    const binCount = Math.ceil((totalHours * 60) / BIN_MINUTES);
    const bins: { power: number[]; hr: number[]; effortFraction: number[] }[] = Array.from({ length: binCount }, () => ({
      power: [],
      hr: [],
      effortFraction: [],
    }));
    for (const p of trimmed) {
      const binIdx = Math.min(binCount - 1, Math.floor((p.tHours * 60) / BIN_MINUTES));
      const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, fittedParams);
      bins[binIdx].power.push(p.grossPowerWPerKg);
      if (ceiling > 0) bins[binIdx].effortFraction.push(p.grossPowerWPerKg / ceiling);
      if (p.heartRateBpm !== undefined) bins[binIdx].hr.push(p.heartRateBpm);
    }

    const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    console.log("bin(h)  power(W/kg)  effortFraction  meanHR(bpm)  nHR");
    const binHoursX: number[] = [];
    const binHrY: number[] = [];
    const binEffortY: number[] = [];
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i];
      if (b.power.length === 0) continue;
      const hrMean = mean(b.hr);
      const efMean = mean(b.effortFraction);
      const tCenter = ((i + 0.5) * BIN_MINUTES) / 60;
      console.log(
        `${tCenter.toFixed(2).padStart(6)}  ${mean(b.power).toFixed(3).padStart(11)}  ${efMean.toFixed(3).padStart(14)}  ${(isNaN(hrMean) ? "--" : hrMean.toFixed(1)).padStart(11)}  ${b.hr.length}`,
      );
      if (b.hr.length > 0) {
        binHoursX.push(tCenter);
        binHrY.push(hrMean);
        binEffortY.push(efMean);
      }
    }

    const hrSlope = linregSlope(binHoursX, binHrY);
    const effortSlope = linregSlope(binHoursX, binEffortY);
    console.log(`\nHR trend: ${hrSlope >= 0 ? "+" : ""}${hrSlope.toFixed(2)} bpm/hour over ${binHoursX.length} bins`);
    console.log(`Effort-fraction trend (at fitted tau=${FITTED_TAU_MIN}min, fInf=${FITTED_FINF}): ${effortSlope >= 0 ? "+" : ""}${(effortSlope * 100).toFixed(3)} pct-points/hour`);
    console.log(`HR range: ${Math.min(...binHrY).toFixed(0)}-${Math.max(...binHrY).toFixed(0)} bpm`);
  }
}

main();
