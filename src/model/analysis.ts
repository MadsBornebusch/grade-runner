// Analysis mode: reconstruct the energy balance of a recorded run from its
// actual GPS speed and elevation, rather than solving for a plan. See
// PLAN.md §4 "Analysis mode" and §5 "Analysis-mode speed".

import type { CourseSegment } from "../gpx/pipeline";
import { CARB_KJ_PER_G, FAT_KJ_PER_G, RESTING_METABOLISM_W_PER_KG, joulesToGrams, netToGross } from "./energetics";
import { costOfRunning, costOfWalking } from "./minetti";
import { type CeilingParams, maxAerobicPower } from "./ceiling";
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
}

export interface AnalysisResult {
  segments: AnalysisSegmentResult[];
  totalElapsedTimeS: number;
  totalMovingTimeS: number;
  bonked: boolean;
  bonkIndex: number | null;
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

  const results: AnalysisSegmentResult[] = [];

  for (const seg of segments) {
    const dt = seg.dtS;
    if (dt === null || dt <= 0) continue;

    const altitudeM = useAltitude ? seg.elevation : 0;
    let speed: number;
    let grossPower: number;

    if (seg.paused) {
      speed = 0;
      grossPower = RESTING_METABOLISM_W_PER_KG;
    } else {
      speed = seg.distance3D / dt;
      const cost = speed <= walkMaxMs ? costOfWalking(seg.gradient) : costOfRunning(seg.gradient);
      grossPower = netToGross(cost * speed);
      cumulativeMovingTimeS += dt;
    }
    cumulativeElapsedTimeS += dt;

    const x = grossPower / maxAerobicPower(altitudeM, inputs.ceilingParams);
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
    });
  }

  return {
    segments: results,
    totalElapsedTimeS: cumulativeElapsedTimeS,
    totalMovingTimeS: cumulativeMovingTimeS,
    bonked: bonkIndex !== null,
    bonkIndex,
  };
}
