// Pacing solver: emergent walk/run choice, forward simulation of a course,
// and bisection on a single effort knob theta. See PLAN.md §5 ("simulate,
// then bisect" — not a closed-form intersection of the aerobic and fuel
// constraints) and §6 (walk/run transition).

import type { CourseSegment } from "../gpx/pipeline";
import { costOfRunning, costOfWalking, maxDescentSpeedMs } from "./minetti";
import { grossToNet, netToGross } from "./energetics";
import { type CeilingParams, ceilingPower, maxAerobicPower, resolveTauMin } from "./ceiling";
import type { DescentExposureBasis } from "./pacingFit";
import {
  type FuelingParams,
  type SubstrateParams,
  splitPower,
  stepGlycogen,
} from "./substrate";

export type LocomotionMode = "run" | "walk";

export interface SolverInputs {
  segments: CourseSegment[];
  bodyMassKg: number;
  ceilingParams?: CeilingParams;
  substrateParams?: SubstrateParams;
  fueling: FuelingParams;
  glycogenStoreG: number;
  reserveG?: number;
  /** Max sustainable walking speed, m/s (PLAN.md §6). Default 2.0. */
  walkMaxMs?: number;
  /** Force walking above this grade (fraction, e.g. 0.25 = 25%). Off by default. */
  forceWalkAboveGrade?: number;
  /** Apply per-segment Cerretelli altitude correction. Default true. */
  altitudeAdjustment?: boolean;
  /**
   * PLAN.md §12/§13 stage 5: which cumulative descent-exposure metric to
   * feed into ceilingPower's optional durabilityDriftPerDescentUnit term
   * (see ceilingParams). Undefined (the default) means no descent-based
   * drift is applied, regardless of what durabilityDriftPerDescentUnit is
   * set to -- matches ceilingPower's own "no exposure means no effect"
   * contract.
   */
  descentExposureBasis?: DescentExposureBasis;
}

export interface SegmentResult {
  index: number;
  mode: LocomotionMode;
  speedMs: number;
  timeS: number;
  cumulativeTimeS: number;
  cumulativeDistance3D: number;
  grossPowerWPerKg: number;
  carbRateWPerKg: number;
  fatRateWPerKg: number;
  glycogenG: number;
  bonked: boolean;
}

export interface SimulationResult {
  /** False if the course could not be completed at this theta without
   * either stalling (speed collapses to 0) or hitting the glycogen reserve floor. */
  feasible: boolean;
  segments: SegmentResult[];
  /** Time to the end of the simulated segments (== finish time iff feasible). */
  finishTimeS: number;
  /** Index of the first segment where glycogen hit the reserve floor, if any. */
  bonkIndex: number | null;
}

const DEFAULT_WALK_MAX_MS = 2.0;
/** No FormInputs field feeds this in production -- glycogen simply depletes
 * toward zero. Kept as an overridable model-layer param (not hardcoded)
 * purely so tests can exercise the floor mechanism directly. */
const DEFAULT_RESERVE_G = 0;

/**
 * Forward-simulates the course at a fixed effort fraction `theta` of the
 * (grade- & altitude-varying, duration-decaying) aerobic ceiling. Stops at
 * the first infeasibility (stall or bonk) rather than continuing in a
 * degraded state — sufficient to locate *where* a bonk would occur and to
 * drive the theta bisection below.
 */
export function simulate(theta: number, inputs: SolverInputs): SimulationResult {
  const reserveG = inputs.reserveG ?? DEFAULT_RESERVE_G;
  const walkMaxMs = inputs.walkMaxMs ?? DEFAULT_WALK_MAX_MS;
  const useAltitude = inputs.altitudeAdjustment ?? true;
  // Resolved once per simulation, not per segment: with a static tauMin this
  // is a no-op passthrough; with tauIntensityModel set, theta IS this
  // simulation's race-average intensity by construction (it's the single
  // effort fraction the whole course is paced at), so tau is derived from it
  // here rather than depending on a per-segment quantity.
  const ceilingParams: CeilingParams = { ...inputs.ceilingParams, tauMin: resolveTauMin(theta, inputs.ceilingParams) };

  let glycogen = { glycogenG: inputs.glycogenStoreG };
  let cumulativeTimeS = 0;
  const results: SegmentResult[] = [];
  let bonkIndex: number | null = null;
  let feasible = true;

  // Running cumulative descent-based exposure (PLAN.md §12/§13 stage 5),
  // updated only when a basis is configured. Deliberately NOT computed via
  // descentImpact.ts's descentStepForSegment: that derives speed from the
  // segment's recorded dtS, which is null for a typical planning-mode
  // course (a route with no timestamps) and, even when present, reflects a
  // past recorded pace rather than the pace this simulation is predicting.
  // Weighted by this segment's own just-computed simulated `speed` instead.
  // "Before this segment" convention, same as pacingFit.ts's cumulative
  // fields and elapsedHours above: reflects exposure from segments already
  // paced, not the descent about to happen in the segment being priced.
  let cumulativeDescentM = 0;
  let cumulativeDescentImpact = 0;
  let cumulativeDescentImpactSquared = 0;
  let previousElevation: number | null = null;

  for (const seg of inputs.segments) {
    const elapsedMin = cumulativeTimeS / 60;
    const elapsedHours = cumulativeTimeS / 3600;
    const altitudeM = useAltitude ? seg.elevation : 0;

    const descentExposure =
      inputs.descentExposureBasis === "descentMeters"
        ? cumulativeDescentM
        : inputs.descentExposureBasis === "descentImpact"
          ? cumulativeDescentImpact
          : inputs.descentExposureBasis === "descentImpactSquared"
            ? cumulativeDescentImpactSquared
            : undefined;

    const ceilingGross = ceilingPower(
      { tMin: elapsedMin, altitudeM, elapsedHours, ...(descentExposure !== undefined ? { descentExposure } : {}) },
      ceilingParams,
    );
    const targetNet = Math.max(0, grossToNet(theta * ceilingGross));

    const costRun = costOfRunning(seg.gradient);
    const costWalk = costOfWalking(seg.gradient);
    const vRun = Math.min(targetNet / costRun, maxDescentSpeedMs(seg.gradient));
    const vWalk = Math.min(walkMaxMs, targetNet / costWalk);

    const forceWalk =
      inputs.forceWalkAboveGrade !== undefined &&
      seg.gradient >= inputs.forceWalkAboveGrade;
    const mode: LocomotionMode = forceWalk || vWalk >= vRun ? "walk" : "run";
    const speed = mode === "run" ? vRun : vWalk;

    if (speed <= 0) {
      feasible = false;
      break;
    }

    const eleDelta =
      previousElevation !== null ? seg.elevation - previousElevation : seg.gradient * seg.distanceHorizontal;
    previousElevation = seg.elevation;
    if (eleDelta < 0) {
      const descentM = -eleDelta;
      cumulativeDescentM += descentM;
      cumulativeDescentImpact += descentM * speed;
      cumulativeDescentImpactSquared += descentM * speed * speed;
    }

    const cost = mode === "run" ? costRun : costWalk;
    const grossPower = netToGross(cost * speed);
    const x = inputs.substrateParams?.intensityIsAbsolutePower
      ? grossPower
      : grossPower / maxAerobicPower(altitudeM, inputs.ceilingParams);
    const split = splitPower(grossPower, x, inputs.bodyMassKg, inputs.substrateParams);

    const dt = seg.distance3D / speed;
    glycogen = stepGlycogen(
      glycogen,
      split.carbRateWPerKg,
      inputs.bodyMassKg,
      inputs.fueling,
      dt,
      reserveG,
    );
    const bonked = glycogen.glycogenG <= reserveG;
    cumulativeTimeS += dt;

    results.push({
      index: seg.index,
      mode,
      speedMs: speed,
      timeS: dt,
      cumulativeTimeS,
      cumulativeDistance3D: seg.cumulativeDistance3D,
      grossPowerWPerKg: grossPower,
      carbRateWPerKg: split.carbRateWPerKg,
      fatRateWPerKg: split.fatRateWPerKg,
      glycogenG: glycogen.glycogenG,
      bonked,
    });

    if (bonked) {
      bonkIndex = seg.index;
      feasible = false;
      break;
    }
  }

  return { feasible, segments: results, finishTimeS: cumulativeTimeS, bonkIndex };
}

export interface BisectionOptions {
  lo?: number;
  hi?: number;
  iterations?: number;
}

export interface SolverResult {
  theta: number;
  result: SimulationResult;
}

/**
 * Bisects on theta for the largest feasible effort fraction. Feasibility is
 * monotonically non-increasing in theta over the range a real pacing plan
 * would target: higher effort means both a higher carb-burn rate and less
 * elapsed time for the gut to replenish it (PLAN.md §5, step 4). But right at
 * the bottom of the range there's a pathological exception: below roughly
 * `P_rest / P_ceiling`, the theta-scaled target gross power drops under
 * resting metabolism and `simulate` reports "infeasible" because net
 * locomotion power collapses to zero (a stall, not a bonk) — which is a
 * *second*, unrelated infeasible region below the real one. A plain bisection
 * between two arbitrary endpoints can land entirely inside that stall region
 * and wrongly conclude nothing is feasible.
 *
 * So this does a coarse forward scan first to find a theta that's actually
 * feasible (skipping over the stall pothole no real pacing plan would target
 * anyway), then bisects between that point and the next infeasible sample
 * above it, where monotonicity genuinely holds.
 */
export function findSustainableTheta(
  inputs: SolverInputs,
  opts: BisectionOptions & { scanSteps?: number } = {},
): SolverResult {
  const hi0 = opts.hi ?? 1;
  const lo0 = opts.lo ?? 0.05;
  const iterations = opts.iterations ?? 30;
  const scanSteps = opts.scanSteps ?? 20;
  const hasIntensityModel = inputs.ceilingParams?.tauIntensityModel !== undefined;

  const distanceReached = (result: SimulationResult): number =>
    result.segments.length > 0
      ? result.segments[result.segments.length - 1].cumulativeDistance3D
      : 0;

  const hiResult = simulate(hi0, inputs);
  // With a static tau, max-feasible-theta is always the fastest feasible
  // plan (see doc comment above), so theta=1 feasible means nothing can beat
  // it -- return immediately. That shortcut does NOT hold with
  // tauIntensityModel (a lower theta can finish faster there -- see
  // resolveTauMin's doc in ceiling.ts), so it's gated to the static case.
  if (hiResult.feasible && !hasIntensityModel) return { theta: hi0, result: hiResult };

  // If no theta is feasible anywhere (checked below), report whichever
  // attempt got furthest before failing -- a real bonk point -- rather than
  // an arbitrary floor pick, which can itself land in the near-zero-effort
  // stall region (see doc comment) and report a meaningless 0km/0s result.
  let furthestTheta = hi0;
  let furthestResult = hiResult;

  // Tracks the FIRST feasible sample seen (as opposed to bestFeasibleTheta
  // below, which tracks the latest/highest) -- only used by the
  // tauIntensityModel path, as the low end of the golden-section bracket.
  let firstFeasibleTheta: number | null = null;
  let bestFeasibleTheta: number | null = null;
  let bestFeasibleResult: SimulationResult | null = null;
  let hi = hi0;
  for (let i = 1; i <= scanSteps; i++) {
    const theta = lo0 + ((hi0 - lo0) * i) / scanSteps;
    const result = simulate(theta, inputs);
    if (distanceReached(result) > distanceReached(furthestResult)) {
      furthestTheta = theta;
      furthestResult = result;
    }
    if (result.feasible) {
      if (firstFeasibleTheta === null) firstFeasibleTheta = theta;
      bestFeasibleTheta = theta;
      bestFeasibleResult = result;
    } else if (bestFeasibleTheta !== null) {
      hi = theta;
      break;
    }
  }

  if (bestFeasibleTheta === null || bestFeasibleResult === null) {
    // No feasible sample anywhere in the scanned range.
    return { theta: furthestTheta, result: furthestResult };
  }

  let lo = bestFeasibleTheta;
  let best = bestFeasibleResult;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const midResult = simulate(mid, inputs);
    if (midResult.feasible) {
      lo = mid;
      best = midResult;
    } else {
      hi = mid;
    }
  }

  // lo/best now hold the largest feasible theta and its result -- the
  // answer, with a static tau (feasibility monotonic, finish time
  // monotonically decreasing across the feasible range, so its upper edge
  // is fastest). With tauIntensityModel, finish time is unimodal instead: a
  // higher theta raises the target power AND shrinks tau, and past some
  // point the resulting late-race fade costs more time than the higher
  // target gains (confirmed empirically across multiple course lengths --
  // see PLAN.md's tau-intensity design notes). Search the now-established
  // feasible bracket for the theta that actually minimizes finish time,
  // rather than returning its upper edge.
  if (hasIntensityModel) {
    return goldenSectionMinimizeFinishTime(inputs, firstFeasibleTheta ?? lo0, lo);
  }
  return { theta: lo, result: best };
}

const GOLDEN_SECTION_RATIO = (Math.sqrt(5) - 1) / 2;
const GOLDEN_SECTION_ITERATIONS = 40;

/**
 * Golden-section search for the theta minimizing finish time over a bracket
 * whose endpoints are already known feasible -- assumes the finish-time-vs-
 * theta curve is unimodal there (single interior minimum, or monotonic to
 * one edge), which is what tauIntensityModel's coupling produces (verified
 * directly, not just assumed -- see findSustainableTheta's doc comment).
 * Not valid for an arbitrary multi-modal objective; only used on this one
 * bracket because that assumption already held up against direct testing.
 */
function goldenSectionMinimizeFinishTime(inputs: SolverInputs, lo0: number, hi0: number): SolverResult {
  const finishOrInf = (result: SimulationResult): number => (result.feasible ? result.finishTimeS : Infinity);

  let a = lo0;
  let b = hi0;
  let c = b - GOLDEN_SECTION_RATIO * (b - a);
  let d = a + GOLDEN_SECTION_RATIO * (b - a);
  let resultC = simulate(c, inputs);
  let resultD = simulate(d, inputs);

  for (let i = 0; i < GOLDEN_SECTION_ITERATIONS; i++) {
    if (finishOrInf(resultC) < finishOrInf(resultD)) {
      b = d;
      d = c;
      resultD = resultC;
      c = b - GOLDEN_SECTION_RATIO * (b - a);
      resultC = simulate(c, inputs);
    } else {
      a = c;
      c = d;
      resultC = resultD;
      d = a + GOLDEN_SECTION_RATIO * (b - a);
      resultD = simulate(d, inputs);
    }
  }
  return finishOrInf(resultC) <= finishOrInf(resultD) ? { theta: c, result: resultC } : { theta: d, result: resultD };
}
