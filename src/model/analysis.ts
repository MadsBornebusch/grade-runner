// Analysis mode: reconstruct the energy balance of a recorded run from its
// actual GPS speed and elevation, rather than solving for a plan. See
// PLAN.md §4 "Analysis mode" and §5 "Analysis-mode speed".

import type { CourseSegment } from "../gpx/pipeline";
import { CARB_KJ_PER_G, FAT_KJ_PER_G, RESTING_METABOLISM_W_PER_KG, joulesToGrams, netToGross } from "./energetics";
import { costOfRunning, costOfWalking } from "./minetti";
import { type CeilingParams, ceilingPower, maxAerobicPower } from "./ceiling";
import { type FuelingParams, type SubstrateParams, splitPower, stepGlycogen } from "./substrate";

export interface AnalysisInputs {
  bodyMassKg: number;
  ceilingParams?: CeilingParams;
  substrateParams?: SubstrateParams;
  fueling: FuelingParams;
  glycogenStoreG: number;
  reserveG?: number;
  /** Speed below which a segment is treated as running vs. walking gait, m/s. Default 2.0. */
  walkMaxMs?: number;
  altitudeAdjustment?: boolean;
}

export interface AnalysisSegmentResult {
  index: number;
  cumulativeDistance3D: number;
  speedMs: number;
  timeS: number;
  cumulativeElapsedTimeS: number;
  cumulativeMovingTimeS: number;
  paused: boolean;
  grossPowerWPerKg: number;
  carbRateWPerKg: number;
  fatRateWPerKg: number;
  cumulativeCarbG: number;
  cumulativeFatG: number;
  glycogenG: number;
  bonked: boolean;
  /** Actual gross power / aerobic ceiling at this point, same basis as
   * avgEffortFraction below. Null for paused segments (no pacing choice to
   * measure). Above 1.0 means this stretch was run harder than the ceiling
   * model says was sustainable for that point in the race. */
  effortFraction: number | null;
}

export interface AnalysisResult {
  segments: AnalysisSegmentResult[];
  totalElapsedTimeS: number;
  totalMovingTimeS: number;
  bonked: boolean;
  bonkIndex: number | null;
  /**
   * Moving-time-weighted average of actual gross power / aerobic ceiling at
   * that point in the run -- the Analysis-mode analog of Planning's solved
   * theta, but descriptive rather than prescriptive: it's what effort you
   * actually held, not a solved sustainable target, so it isn't bounded at
   * 100% the way theta is (e.g. it reads over 100% if you paced harder than
   * your ceiling model says was sustainable for that duration, which can
   * mean either a courageous push or that your ceiling params are stale).
   * Paused segments are excluded -- resting metabolism isn't a pacing choice.
   */
  avgEffortFraction: number;
}

const DEFAULT_RESERVE_G = 60;
const DEFAULT_WALK_MAX_MS = 2.0;

/**
 * Reconstructs metabolic power, substrate split, and glycogen balance from a
 * recorded run's actual per-segment speed (not a target pace). Paused
 * segments (from the pipeline's speed-based pause detection) are costed at
 * resting metabolism instead of a phantom movement cost. Since GPS alone
 * doesn't record gait, running vs. walking is inferred from a speed
 * threshold (PLAN.md §6's ~2 m/s anchor) purely to pick which Minetti cost
 * curve applies.
 */
export function analyzeRun(segments: CourseSegment[], inputs: AnalysisInputs): AnalysisResult {
  const reserveG = inputs.reserveG ?? DEFAULT_RESERVE_G;
  const walkMaxMs = inputs.walkMaxMs ?? DEFAULT_WALK_MAX_MS;
  const useAltitude = inputs.altitudeAdjustment ?? true;

  let glycogen = { glycogenG: inputs.glycogenStoreG };
  let cumulativeElapsedTimeS = 0;
  let cumulativeMovingTimeS = 0;
  let cumulativeCarbG = 0;
  let cumulativeFatG = 0;
  let bonkIndex: number | null = null;
  let effortWeightedSum = 0;
  let effortWeightS = 0;

  const results: AnalysisSegmentResult[] = [];

  for (const seg of segments) {
    const dt = seg.dtS;
    if (dt === null || dt <= 0) continue;

    const altitudeM = useAltitude ? seg.elevation : 0;
    const elapsedBeforeS = cumulativeElapsedTimeS;
    let speed: number;
    let grossPower: number;
    let effortFraction: number | null = null;

    if (seg.paused) {
      speed = 0;
      grossPower = RESTING_METABOLISM_W_PER_KG;
    } else {
      speed = seg.distance3D / dt;
      const cost = speed <= walkMaxMs ? costOfWalking(seg.gradient) : costOfRunning(seg.gradient);
      grossPower = netToGross(cost * speed);
      cumulativeMovingTimeS += dt;

      const ceilingGross = ceilingPower(
        { tMin: elapsedBeforeS / 60, altitudeM, elapsedHours: elapsedBeforeS / 3600 },
        inputs.ceilingParams,
      );
      if (ceilingGross > 0) {
        effortFraction = grossPower / ceilingGross;
        effortWeightedSum += effortFraction * dt;
        effortWeightS += dt;
      }
    }
    cumulativeElapsedTimeS += dt;

    const x = inputs.substrateParams?.intensityIsAbsolutePower
      ? grossPower
      : grossPower / maxAerobicPower(altitudeM, inputs.ceilingParams);
    const split = splitPower(grossPower, x, inputs.bodyMassKg, inputs.substrateParams);

    glycogen = stepGlycogen(glycogen, split.carbRateWPerKg, inputs.bodyMassKg, inputs.fueling, dt, reserveG);
    const bonked = glycogen.glycogenG <= reserveG;
    if (bonked && bonkIndex === null) bonkIndex = seg.index;

    cumulativeCarbG += joulesToGrams(split.carbRateWPerKg * inputs.bodyMassKg * dt, CARB_KJ_PER_G);
    cumulativeFatG += joulesToGrams(split.fatRateWPerKg * inputs.bodyMassKg * dt, FAT_KJ_PER_G);

    results.push({
      index: seg.index,
      cumulativeDistance3D: seg.cumulativeDistance3D,
      speedMs: speed,
      timeS: dt,
      cumulativeElapsedTimeS,
      cumulativeMovingTimeS,
      paused: seg.paused,
      grossPowerWPerKg: grossPower,
      carbRateWPerKg: split.carbRateWPerKg,
      fatRateWPerKg: split.fatRateWPerKg,
      cumulativeCarbG,
      cumulativeFatG,
      glycogenG: glycogen.glycogenG,
      bonked,
      effortFraction,
    });
  }

  return {
    segments: results,
    totalElapsedTimeS: cumulativeElapsedTimeS,
    totalMovingTimeS: cumulativeMovingTimeS,
    bonked: bonkIndex !== null,
    bonkIndex,
    avgEffortFraction: effortWeightS > 0 ? effortWeightedSum / effortWeightS : 0,
  };
}
