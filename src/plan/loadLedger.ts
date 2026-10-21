// PLAN.md §15 layer 1: the training-load ledger. One load record per
// activity, summed into a daily series per channel, plus the fixed-constant
// EWMAs (42-day chronic, 7-day acute) the plan generator uses as its ruler.
// Nothing here is fitted per athlete -- the EWMAs are an accounting unit, not
// a performance model (§12 Q3 rejects fitted fitness-fatigue models; §15
// explains why a fixed-constant EWMA is still fine for prescribing load).
//
// Two channels, the usual split between musculoskeletal and cardio load:
//   - mechanical: runningImpact.ts's score (distance + Minetti hill
//     surcharge), the musculoskeletal "wheels and suspension" load. Runs only.
//   - metabolic: TSS-style, 100 x hours x IF^2, with IF = smoothed gross
//     metabolic power (pace-derived via Minetti, from analysis.ts) over the
//     athlete's threshold power. HR-free, so it works for any recorded run.
// Descent metres are kept alongside as their own quantity for the eccentric
// load, since §15's plan generator progresses descent as a separate target.
//
// Activities without usable points (treadmill, manual entries, runs whose
// points aren't fetched yet) go through activityLoadFromSummary, an
// approximation from distance/elevation/time only. Its records are tagged
// source "summary" so callers can keep the two apart.

import type { CourseSegment } from "../gpx/pipeline";
import type { AnalysisResult } from "../model/analysis";
import { descentMeters } from "../model/descentImpact";
import { netToGross } from "../model/energetics";
import { costOfRunning } from "../model/minetti";
import { runningImpact } from "../model/runningImpact";

export type LoadChannel = "mechanical" | "metabolic" | "descentM";

export interface ActivityLoad {
  activityId: string;
  /** Local calendar date, YYYY-MM-DD (see localDateKey). */
  date: string;
  movingS: number;
  mechanical: number;
  metabolic: number;
  descentM: number;
  source: "points" | "summary";
}

/** Trailing window for smoothing gross power before squaring it. Squaring
 * raw ~25 m segment power would let GPS speed noise inflate the load (the
 * mean of a square exceeds the square of the mean), the same reason TSS-style
 * scores use a ~30 s rolling average first. */
export const DEFAULT_METABOLIC_SMOOTHING_S = 60;

/**
 * 100 x hours x IF^2 over moving segments, IF = trailing-window time-weighted
 * mean gross power / threshold gross power. Paused segments contribute
 * nothing and are skipped by the smoothing window too. `thresholdGrossPowerWPerKg`
 * is an explicit input (typically maxAerobicPower(0, params) x lt2Fraction):
 * the absolute scale of this score moves with it squared.
 */
export function metabolicLoad(
  analysis: Pick<AnalysisResult, "segments">,
  thresholdGrossPowerWPerKg: number,
  smoothingS: number = DEFAULT_METABOLIC_SMOOTHING_S,
): number {
  if (!(thresholdGrossPowerWPerKg > 0)) throw new Error("thresholdGrossPowerWPerKg must be positive");
  const moving = analysis.segments.filter((s) => !s.paused && s.timeS > 0);
  let load = 0;
  let windowEnergy = 0;
  let windowTime = 0;
  let start = 0;
  for (let i = 0; i < moving.length; i++) {
    const seg = moving[i];
    windowEnergy += seg.grossPowerWPerKg * seg.timeS;
    windowTime += seg.timeS;
    while (start < i && windowTime - moving[start].timeS >= smoothingS) {
      windowEnergy -= moving[start].grossPowerWPerKg * moving[start].timeS;
      windowTime -= moving[start].timeS;
      start++;
    }
    const intensity = windowEnergy / windowTime / thresholdGrossPowerWPerKg;
    load += (seg.timeS / 3600) * 100 * intensity * intensity;
  }
  return load;
}

export interface CourseLoadInput {
  activityId: string;
  date: string;
  segments: CourseSegment[];
  /** analyzeRun's result for the same segments. */
  analysis: AnalysisResult;
  thresholdGrossPowerWPerKg: number;
}

export function activityLoadFromCourse(input: CourseLoadInput): ActivityLoad {
  return {
    activityId: input.activityId,
    date: input.date,
    movingS: input.analysis.totalMovingTimeS,
    mechanical: runningImpact(input.segments),
    metabolic: metabolicLoad(input.analysis, input.thresholdGrossPowerWPerKg),
    descentM: descentMeters(input.segments),
    source: "points",
  };
}

export interface SummaryLoadCoefficients {
  /** Mechanical load per km. */
  mechanicalPerKm: number;
  /** Mechanical load per 100 m of elevation gain. */
  mechanicalPer100mGain: number;
  /** Flat-equivalent metres added per metre of gain, for the speed that
   * sets the metabolic IF (a Naismith/GAP-style rule). */
  flatEquivalentMPerMGain: number;
}

/**
 * Least-squares fit against the points-based ledger on this athlete's 328
 * cached runs (2020-2026), at their own VO2max and LT2 for the metabolic term.
 * In-sample error against the points-based ledger on those runs: mechanical
 * about 4%, metabolic about 14%, descent about 10%. An approximation for
 * activities without points, not a validated constant.
 */
export const DEFAULT_SUMMARY_LOAD_COEFFICIENTS: SummaryLoadCoefficients = {
  mechanicalPerKm: 6.43,
  mechanicalPer100mGain: 4.75,
  flatEquivalentMPerMGain: 2,
};

export interface SummaryLoadInput {
  activityId: string;
  date: string;
  distanceKm: number;
  elevationGainM: number;
  movingS: number;
  thresholdGrossPowerWPerKg: number;
}

/** Summary-only approximation: mechanical from distance and gain; metabolic
 * from one IF for the whole activity, at its flat-equivalent average speed;
 * descent assumed equal to gain (a loop). */
export function activityLoadFromSummary(
  input: SummaryLoadInput,
  coefficients: SummaryLoadCoefficients = DEFAULT_SUMMARY_LOAD_COEFFICIENTS,
): ActivityLoad {
  const gain = Math.max(0, input.elevationGainM);
  let metabolic = 0;
  if (input.movingS > 0) {
    const flatEquivalentSpeed = (input.distanceKm * 1000 + coefficients.flatEquivalentMPerMGain * gain) / input.movingS;
    const intensity = netToGross(costOfRunning(0) * flatEquivalentSpeed) / input.thresholdGrossPowerWPerKg;
    metabolic = (input.movingS / 3600) * 100 * intensity * intensity;
  }
  return {
    activityId: input.activityId,
    date: input.date,
    movingS: input.movingS,
    mechanical: coefficients.mechanicalPerKm * input.distanceKm + (coefficients.mechanicalPer100mGain * gain) / 100,
    metabolic,
    descentM: gain,
    source: "summary",
  };
}

/** YYYY-MM-DD of `instant` in `timeZone` (IANA name), so an evening run in
 * Norway isn't filed under the next UTC day. */
export function localDateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant,
  );
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `dateKey`. */
export function weekStart(dateKey: string): string {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return addDays(dateKey, -((day + 6) % 7));
}

export interface DailyLoad {
  date: string;
  value: number;
}

/** One entry per calendar day from `from` to `to` inclusive, zero on days
 * with no activity. */
export function dailySeries(activities: ActivityLoad[], channel: LoadChannel, from: string, to: string): DailyLoad[] {
  const byDate = new Map<string, number>();
  for (const a of activities) byDate.set(a.date, (byDate.get(a.date) ?? 0) + a[channel]);
  const out: DailyLoad[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, value: byDate.get(d) ?? 0 });
  return out;
}

export const CHRONIC_TAU_DAYS = 42;
export const ACUTE_TAU_DAYS = 7;

/** level_t = level_{t-1} + (x_t - level_{t-1}) / tau, the CTL/ATL form of
 * TrainingPeaks' Performance Management Chart. `seed` is the level
 * before the first day, so a series can start mid-history. */
export function ewma(values: number[], tauDays: number, seed = 0): number[] {
  const out: number[] = [];
  let level = seed;
  for (const x of values) {
    level += (x - level) / tauDays;
    out.push(level);
  }
  return out;
}

export interface SpikeCapOptions {
  /** Look-back window for the athlete's recent biggest day. */
  windowDays?: number;
  /** Longer look-back used only after a break, when the short window is
   * nearly empty. */
  returnWindowDays?: number;
  /** A day passes uncapped up to this multiple of the reference day. */
  maxMultiple?: number;
  /** A day above this multiple of its reference is treated as a race
   * (Frandsen's "large" spike, > 100% over the recent longest). */
  raceMultiple?: number;
  /** A race counts toward later reference days at only this multiple of its
   * own reference: one Frandsen-sized step, not its capped size. */
  raceCredit?: number;
}

/**
 * The load series to *prescribe from*: each day limited to maxMultiple x a
 * reference day, the biggest (capped) day of the previous windowDays, or
 * half the biggest of the previous returnWindowDays if that is larger.
 * Without this, a 26 h race lifts the chronic level ~45% in one day and
 * every plan for the following weeks is scaled off it (§15 weakness 2).
 *
 * The default 1.3x lets normal long-run progression through untouched
 * (§15's spike guard holds prescribed sessions to about 1.1x the recent
 * longest) while a race counts as at most one progression-sized long run.
 * A race (more than raceMultiple, 2x, its reference) enters later
 * references at only raceCredit (1.1x) its own reference, so afterwards the
 * allowance is the longest pre-race training day plus one 10% step (PLAN.md
 * §15, "Guard reference after a race": with the race counted at its capped
 * 1.3x, a +28% road long run four weeks after the 2025 backyard ultra
 * passed unnoticed). Smaller capped days count at their capped size, so a
 * build of 25-30% long-run steps isn't frozen. Nothing in the first
 * window of a history is capped, so a race there counts in full. The
 * longer return window keeps the first runs after a break from being
 * trimmed against an empty month. Validate and display the raw series;
 * use this one only for prescribing.
 */
export function capSpikes(values: number[], options: SpikeCapOptions = {}): number[] {
  return spikeReferences(values, options).capped;
}

/** capSpikes's capped series plus each day's reference, the race-excluded
 * recent biggest day that the plan's 1.1x spike guard compares against. */
export function spikeReferences(
  values: number[],
  options: SpikeCapOptions = {},
): { capped: number[]; reference: number[] } {
  const windowDays = options.windowDays ?? 30;
  const returnWindowDays = options.returnWindowDays ?? 90;
  const maxMultiple = options.maxMultiple ?? 1.3;
  const raceMultiple = options.raceMultiple ?? 2;
  const raceCredit = options.raceCredit ?? 1.1;
  const out: number[] = [];
  const references: number[] = [];
  const credited: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let recentMax = 0;
    let returnMax = 0;
    for (let j = Math.max(0, i - returnWindowDays); j < i; j++) {
      returnMax = Math.max(returnMax, credited[j]);
      if (j >= i - windowDays) recentMax = Math.max(recentMax, credited[j]);
    }
    const reference = Math.max(recentMax, 0.5 * returnMax);
    references.push(reference);
    // Nothing is capped or treated as a race in the first window of a
    // history: the reference there is still just the first few easy days,
    // and every long run would look like a spike.
    const established = i >= windowDays && reference > 0;
    const capped = established ? Math.min(values[i], maxMultiple * reference) : values[i];
    out.push(capped);
    const race = established && values[i] > raceMultiple * reference;
    credited.push(race ? raceCredit * reference : capped);
  }
  return { capped: out, reference: references };
}
