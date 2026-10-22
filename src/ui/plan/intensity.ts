// Effort targets for the plan's sessions, from the athlete's thresholds.
// The generator only says what kind of effort (easy, steady at race effort,
// threshold); this turns that into heart-rate ranges where the settings
// allow, and words where they don't. No pace targets: on trail they mean
// little.
import { maxAerobicPower } from "../../model/ceiling";
import { predictHeartRateFromPower } from "../../model/hrCalibration";
import { paceToGrossPowerWPerKg } from "../../model/substrate";
import { resolveLt1Lt2Fractions, resolveVo2Max, type FormInputs } from "../formInputs";

export interface HrRange {
  lo: number;
  hi: number;
}

export interface IntensityTargets {
  /** Upper end of easy running (LT1), bpm. */
  easyMaxHr: number | null;
  /** The long run's steady block: race effort up to LT1. */
  steady: HrRange | null;
  /** Threshold work, around LT2. */
  quality: HrRange | null;
  /** The race's predicted effort reaches LT1, so steady = just under LT1. */
  raceAtLt1: boolean;
}

/** Heart rate at a gross power (W/kg), from what the settings carry:
 * fat-ox test stages with heart rate, else the fitted HR-power line, else
 * the line through the LT1 and LT2 heart rates. */
export function heartRateAtPower(formInputs: FormInputs): ((wPerKg: number) => number) | null {
  const stages = formInputs.fatOxPoints
    .filter((p) => p.heartRateBpm)
    .map((p) => ({ x: paceToGrossPowerWPerKg(p.paceMinPerKm, formInputs.walkMaxMs), hr: p.heartRateBpm! }))
    .sort((a, b) => a.x - b.x);
  if (stages.length >= 2) {
    return (x) => {
      // Between the stages around x, extended past the ends.
      const above = stages.findIndex((s) => s.x >= x);
      const i = above < 0 ? stages.length - 1 : Math.max(1, above);
      const [a, b] = [stages[i - 1], stages[i]];
      return a.hr + ((b.hr - a.hr) * (x - a.x)) / (b.x - a.x || 1);
    };
  }
  const { hrPowerCalibrationSlope: slope, hrPowerCalibrationIntercept: intercept } = formInputs;
  if (slope !== null && intercept !== null) return (x) => predictHeartRateFromPower(x, { slope, intercept, rSquared: 0, pointCount: 0, raceCount: 0 });
  const { lt1, lt2 } = thresholdPowers(formInputs);
  const { lt1HeartRateBpm: h1, lt2HeartRateBpm: h2 } = formInputs;
  if (h1 !== null && h2 !== null && lt2 > lt1) return (x) => h1 + ((h2 - h1) * (x - lt1)) / (lt2 - lt1);
  return null;
}

function thresholdPowers(formInputs: FormInputs): { lt1: number; lt2: number } {
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(formInputs);
  const ceiling = maxAerobicPower(0, { vo2MaxMlPerKgPerMin: resolveVo2Max(formInputs.vo2MaxHistory) });
  return { lt1: lt1Fraction * ceiling, lt2: lt2Fraction * ceiling };
}

const r = Math.round;

export function intensityTargets(formInputs: FormInputs, raceEffortWPerKg: number | null | undefined): IntensityTargets {
  const hrAt = heartRateAtPower(formInputs);
  const { lt1, lt2 } = thresholdPowers(formInputs);
  const lt1Hr = formInputs.lt1HeartRateBpm ?? (hrAt ? r(hrAt(lt1)) : null);
  const lt2Hr = formInputs.lt2HeartRateBpm ?? (hrAt ? r(hrAt(lt2)) : null);
  const raceAtLt1 = !!raceEffortWPerKg && raceEffortWPerKg >= lt1;
  let steady: HrRange | null = null;
  if (lt1Hr !== null) {
    const raceHr = raceEffortWPerKg && hrAt && !raceAtLt1 ? r(hrAt(raceEffortWPerKg)) : null;
    // A range of at least 5 bpm: heart rate wanders that much anyway.
    steady = { lo: Math.min(raceHr ?? lt1Hr - 10, lt1Hr - 5), hi: lt1Hr };
  }
  return {
    easyMaxHr: lt1Hr,
    steady,
    quality: lt2Hr !== null ? { lo: lt2Hr - 5, hi: lt2Hr + 2 } : null,
    raceAtLt1,
  };
}
