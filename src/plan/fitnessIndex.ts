// PLAN.md §15 layer 2: a per-run fitness index, so easy runs (most of the
// log) give a fitness reading too. vo2MaxEstimate.ts only works on 20-90 min
// hard efforts and the pooled HR fits only on long races.
//
// Index = power at a fixed reference heart rate. One run's HR range is
// usually narrow (an easy run sits within ~10 bpm), so a per-run HR-power
// slope would be mostly noise. Instead the slope is pooled across runs from
// *within-run* variation only (each run demeaned by its own means, so
// between-run fitness differences don't leak into it), and each run only
// contributes its level: the power its mean HR implies, shifted along the
// pooled slope to the reference HR. Samples come from hrCalibration.ts's
// collectRaceSamples (start trim, early window against cardiac drift, GPS
// artifact filter, smoothed power, recovery-lag down-weighting).
//
// "Power" is whatever the points carry in grossPowerWPerKg: pace-derived
// (Minetti, analysis.ts) by default, or a device's measured power, so the
// two can be compared for noise.

import { collectRaceSamples, type Sample } from "../model/hrCalibration";
import type { EffortTrendPoint } from "../model/pacingFit";

/** Below this much usable sample time a run gives no index. */
export const MIN_INDEX_SAMPLE_MIN = 15;

/** Same bound as hrCalibration.ts's MAX_PLAUSIBLE_POWER_W_PER_KG, applied
 * to the smoothed sample power. */
const MAX_SAMPLE_POWER_W_PER_KG = 20;

export interface RunHrPowerSummary {
  /** Sample-weight-weighted means. */
  meanHr: number;
  meanPower: number;
  /** Total weight, ~seconds of usable samples. */
  weight: number;
  samples: Sample[];
}

export function summarizeRunSamples(
  points: EffortTrendPoint[],
  include?: (index: number) => boolean,
  minSampleMin: number = MIN_INDEX_SAMPLE_MIN,
): RunHrPowerSummary | null {
  // collectRaceSamples drops raw GPS spikes, but a burst of them can still
  // lift the 75 s smoothed power; no real sustained effort is above this.
  const samples = collectRaceSamples(points, 1, include).filter((s) => s.powerWPerKg <= MAX_SAMPLE_POWER_W_PER_KG);
  const weight = samples.reduce((s, x) => s + x.weight, 0);
  if (weight < minSampleMin * 60) return null;
  const meanHr = samples.reduce((s, x) => s + x.weight * x.hr, 0) / weight;
  const meanPower = samples.reduce((s, x) => s + x.weight * x.powerWPerKg, 0) / weight;
  return { meanHr, meanPower, weight, samples };
}

/**
 * Pooled within-run slope of power on HR (power units per bpm). Each run is
 * demeaned by its own weighted means, so only how power and HR move together
 * inside a run counts. Null without any within-run HR variation.
 */
export function pooledPowerPerBpm(runs: RunHrPowerSummary[]): number | null {
  let sxy = 0;
  let sxx = 0;
  for (const r of runs) {
    for (const s of r.samples) {
      const dh = s.hr - r.meanHr;
      sxy += s.weight * dh * (s.powerWPerKg - r.meanPower);
      sxx += s.weight * dh * dh;
    }
  }
  return sxx > 0 ? sxy / sxx : null;
}

/**
 * The same within-run pooled fit the other way round: HR on power, inverted
 * to power per bpm. Regressing power on HR attenuates the slope when HR is
 * the noisier, lagged variable (errors-in-variables), so the two bracket the
 * true slope; this one is the steeper bracket.
 */
export function pooledPowerPerBpmFromHrOnPower(runs: RunHrPowerSummary[]): number | null {
  let sxy = 0;
  let syy = 0;
  for (const r of runs) {
    for (const s of r.samples) {
      const dp = s.powerWPerKg - r.meanPower;
      sxy += s.weight * dp * (s.hr - r.meanHr);
      syy += s.weight * dp * dp;
    }
  }
  return sxy > 0 && syy > 0 ? syy / sxy : null;
}

/** A run whose mean HR is further than this from the reference gives no
 * index: the pooled slope is only trusted over a short extrapolation, and a
 * failing strap (mean HR far too low) would otherwise read as huge fitness. */
export const MAX_REFERENCE_HR_DISTANCE_BPM = 15;

/** Power at `referenceHr` for one run, moved from the run's own mean along
 * the pooled slope; null beyond MAX_REFERENCE_HR_DISTANCE_BPM. */
export function powerAtReferenceHr(run: RunHrPowerSummary, powerPerBpm: number, referenceHr: number): number | null {
  if (Math.abs(referenceHr - run.meanHr) > MAX_REFERENCE_HR_DISTANCE_BPM) return null;
  return run.meanPower + powerPerBpm * (referenceHr - run.meanHr);
}

/** The settings stage 2 froze (PLAN.md §15): samples whose trailing 2 min
 * stayed within +-8% grade, at least 8 min of them. */
export const FLAT_MAX_GRADE = 0.08;
export const FLAT_WINDOW_S = 120;
export const FROZEN_MIN_SAMPLE_MIN = 8;

/**
 * Per trend point: true if every segment in the trailing `windowS` stayed
 * within +-maxGrade, so HR isn't still settling from a climb that just
 * ended. `gradients[i]` is trend point i's segment gradient. maxGrade 0
 * turns the filter off.
 */
export function flatSampleMask(
  trend: EffortTrendPoint[],
  gradients: number[],
  maxGrade: number = FLAT_MAX_GRADE,
  windowS: number = FLAT_WINDOW_S,
): boolean[] {
  return trend.map((p, i) => {
    if (!(maxGrade > 0)) return true;
    for (let j = i; j >= 0 && (p.tHours - trend[j].tHours) * 3600 <= windowS; j--) {
      if (Math.abs(gradients[j] ?? 0) > maxGrade) return false;
    }
    return true;
  });
}
