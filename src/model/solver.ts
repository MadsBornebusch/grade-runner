// Pacing solver: emergent walk/run choice, forward simulation of a course,
// and bisection on a single effort knob theta. See PLAN.md §5 ("simulate,
// then bisect" — not a closed-form intersection of the aerobic and fuel
// constraints) and §6 (walk/run transition).

import type { CourseSegment, SurfaceCategory } from "../gpx/pipeline";
import { costOfRunning, costOfWalking, maxDescentSpeedMs } from "./minetti";
import { grossToNet, netToGross } from "./energetics";
import { type CeilingParams, ceilingPower, maxAerobicPower, sustainableFraction } from "./ceiling";
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
  /**
   * Flat cost multiplier applied to costOfRunning/costOfWalking on segments
   * classified unpaved (see gpx/pipeline.ts's CourseSegment.surfaceUnpaved
   * and surfaceExposure.ts's attachSurfaceData). 1 = off (default) --
   * chosen over two rejected alternatives after leave-one-out backtests
   * against real races: (1) an earlier cumulative-exposure durability-drift
   * design (mirroring descent's mechanism) fit far worse (~25% mean error
   * vs ~9% for this flat version) -- technical terrain appears to cost more
   * to move across right there, not to accumulate fatigue that lingers once
   * you're back on pavement; (2) a hard cap on unpaved run speed (mirroring
   * maxDescentSpeedMs), motivated by this athlete's recorded effort fraction
   * not actually being elevated on unpaved terrain, also fit worse (~13%)
   * once compared honestly -- a cost multiplier apparently captures the
   * gradient-dependence of technical terrain (steep+technical costs more
   * than flat+technical) that a flat speed cap can't.
   */
  unpavedCostMultiplier?: number;
  /**
   * PLAN.md §14 Plan B, Stage 6: per-category cost multiplier (keyed by
   * gpx/pipeline.ts's SurfaceCategory), fit from jointSlowdownFit.ts's
   * within-run surface coefficients rather than assumed as a single flat
   * binary value. Takes priority over unpavedCostMultiplier when a
   * segment's own surfaceCategory has an entry here -- falls back to the
   * binary unpavedCostMultiplier logic otherwise (undefined, or the
   * category has no entry), so passing neither keeps this byte-for-byte
   * identical to before this field existed.
   */
  surfaceCostMultipliers?: Partial<Record<SurfaceCategory, number>>;
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

export interface SimulateOptions {
  /**
   * PLAN.md §14 Plan B, pacing-margin follow-up: when set, the aerobic
   * ceiling's duration-decay term (ceilingPower's sustainableFraction) is
   * evaluated at this FIXED value (minutes) instead of each segment's own
   * running elapsed time -- i.e. "flat effort matched to a race of this
   * total duration" instead of "effort that itself decays as elapsed time
   * within THIS simulation grows". Altitude and any configured
   * durabilityDriftPerHour/PerDescentUnit still use each segment's own
   * REAL running elapsedHours/altitude/descentExposure unchanged -- only
   * the time->fraction decay curve goes flat, not every duration-sensitive
   * term. Undefined (the default) is byte-for-byte identical to before
   * this option existed (see findFlatPacedFinishTime for how it's driven).
   */
  flatDurationMin?: number;
}

/**
 * Forward-simulates the course at a fixed effort fraction `theta` of the
 * (grade- & altitude-varying, duration-decaying) aerobic ceiling. Stops at
 * the first infeasibility (stall or bonk) rather than continuing in a
 * degraded state — sufficient to locate *where* a bonk would occur and to
 * drive the theta bisection below.
 */
export function simulate(theta: number, inputs: SolverInputs, opts: SimulateOptions = {}): SimulationResult {
  const reserveG = inputs.reserveG ?? DEFAULT_RESERVE_G;
  const walkMaxMs = inputs.walkMaxMs ?? DEFAULT_WALK_MAX_MS;
  const useAltitude = inputs.altitudeAdjustment ?? true;

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
  const unpavedCostMultiplier = inputs.unpavedCostMultiplier ?? 1;

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
      {
        tMin: opts.flatDurationMin ?? elapsedMin,
        altitudeM,
        elapsedHours,
        ...(descentExposure !== undefined ? { descentExposure } : {}),
      },
      inputs.ceilingParams,
    );
    const targetNet = Math.max(0, grossToNet(theta * ceilingGross));

    const perCategoryMultiplier =
      seg.surfaceCategory !== undefined ? inputs.surfaceCostMultipliers?.[seg.surfaceCategory] : undefined;
    const terrainMultiplier = perCategoryMultiplier ?? (seg.surfaceUnpaved ? unpavedCostMultiplier : 1);
    const costRun = costOfRunning(seg.gradient) * terrainMultiplier;
    const costWalk = costOfWalking(seg.gradient) * terrainMultiplier;
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

  const distanceReached = (result: SimulationResult): number =>
    result.segments.length > 0
      ? result.segments[result.segments.length - 1].cumulativeDistance3D
      : 0;

  const hiResult = simulate(hi0, inputs);
  if (hiResult.feasible) return { theta: hi0, result: hiResult };

  // If no theta is feasible anywhere (checked below), report whichever
  // attempt got furthest before failing -- a real bonk point -- rather than
  // an arbitrary floor pick, which can itself land in the near-zero-effort
  // stall region (see doc comment) and report a meaningless 0km/0s result.
  let furthestTheta = hi0;
  let furthestResult = hiResult;

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
  return { theta: lo, result: best };
}

export interface FlatPacingOptions {
  /** Multiplicative range around the seed estimate (findSustainableTheta's
   * own finish time) to scan for a self-consistent duration. Defaults
   * 0.4x-3x -- wide enough to comfortably bracket the ~20-30% gap this
   * mechanism is meant to close, without being so wide the coarse scan
   * loses resolution. */
  loMultiplier?: number;
  hiMultiplier?: number;
  scanSteps?: number;
  iterations?: number;
}

export interface FlatPacedResult {
  /** The self-consistent assumed-and-actual duration, minutes. */
  totalDurationMin: number;
  /** sustainableFraction(totalDurationMin, ceilingParams) -- the single flat
   * effort fraction targeted for the whole race. */
  targetFraction: number;
  result: SimulationResult;
  /** False if no self-consistent duration could be bracketed within the
   * scanned range -- falls back to the furthest-progress estimate, same
   * "report what we've got" discipline as findSustainableTheta's own
   * total-failure fallback, rather than a meaningless arbitrary pick. */
  selfConsistent: boolean;
}

/**
 * PLAN.md §14 Plan B, pacing-margin follow-up: predicts finish time
 * assuming PERFECT, EVEN pacing -- a single flat effort fraction held for
 * the whole race, set to whatever sustainableFraction says is achievable
 * for a race that takes exactly this long -- instead of findSustainableTheta's
 * design (a constant theta multiplier on top of a ceiling that itself
 * decays continuously with elapsed time WITHIN the simulated race, i.e. an
 * implicitly front-loaded/declining effort trajectory).
 *
 * This is a genuine repurposing of the SAME fitted tau/f0/fInf curve, not a
 * new one: that curve was fit as a within-race decay trajectory
 * (pacingFit.ts's own tHours-vs-effortFraction fit), and is reused here as
 * "the sustainable flat level for a race of this total length" -- a
 * different but related reading of the same shape, consistent with (not
 * proven by) the psychobiological pacing literature's view that well-paced
 * endurance effort approximates even pacing rather than starting hot and
 * declining (PLAN.md's own literature note on this).
 *
 * Solves a FIXED POINT, not a monotonic feasibility boundary: for a
 * candidate total duration T (minutes), the flat target fraction is
 * sustainableFraction(T); forward-simulating the whole course at that flat
 * fraction gives an ACTUAL duration -- self-consistent exactly when that
 * actual duration equals the assumed T. Bisects on e(T) = actualMinutes(T)
 * - T (sign change from + at small/aggressive T to - at large/conservative
 * T), with the same defensive coarse-scan-first discipline
 * findSustainableTheta uses -- walk/run gait-mode switches put kinks in
 * actualMinutes(T) the same way they do in theta's own feasibility
 * boundary, so a plain bisection without a scan first isn't safe here
 * either. A candidate T whose flat simulation bonks or stalls is treated as
 * actualMinutes(T) = +Infinity (i.e. "too aggressive, need a larger/slower
 * T"), folding fuel-feasibility into the same search rather than a second,
 * separate check -- so a fuel-limited course's self-consistent answer ends
 * up flat-at-whatever-the-glycogen-reservoir-allows, which is correct but
 * means the "matches the duration curve exactly" property only holds in
 * the aerobically-limited regime, not the fuel-limited one.
 */
export function findFlatPacedFinishTime(inputs: SolverInputs, opts: FlatPacingOptions = {}): FlatPacedResult {
  const scanSteps = opts.scanSteps ?? 40;
  const iterations = opts.iterations ?? 40;

  const distanceReached = (result: SimulationResult): number =>
    result.segments.length > 0 ? result.segments[result.segments.length - 1].cumulativeDistance3D : 0;

  const actualMinutesFor = (candidateMin: number): { minutes: number; result: SimulationResult } => {
    const result = simulate(1, inputs, { flatDurationMin: candidateMin });
    return { minutes: result.feasible ? result.finishTimeS / 60 : Infinity, result };
  };

  // Seed the search range off the existing theta-based estimate -- already
  // in the right ballpark (this mechanism is meant to close a ~20-30% gap,
  // not an order of magnitude), and avoids a blind search across durations
  // that could span minutes to days. Falls back to a wide absolute range
  // if even that seed isn't feasible at all.
  const seed = findSustainableTheta(inputs);
  const seedMin = seed.result.feasible ? seed.result.finishTimeS / 60 : null;
  const loMin = seedMin !== null ? seedMin * (opts.loMultiplier ?? 0.4) : 10;
  const hiMin = seedMin !== null ? seedMin * (opts.hiMultiplier ?? 3) : 4000;

  let prevT = loMin;
  let prev = actualMinutesFor(prevT);
  let prevE = prev.minutes - prevT;

  let bestFallbackT = prevT;
  let bestFallbackResult = prev.result;

  let bracketLo: number | null = null;
  let bracketHi: number | null = null;

  for (let i = 1; i <= scanSteps; i++) {
    const t = loMin + ((hiMin - loMin) * i) / scanSteps;
    const cur = actualMinutesFor(t);
    const curE = cur.minutes - t;

    if (distanceReached(cur.result) > distanceReached(bestFallbackResult)) {
      bestFallbackT = t;
      bestFallbackResult = cur.result;
    }

    if (prevE > 0 && curE <= 0) {
      bracketLo = prevT;
      bracketHi = t;
      break;
    }
    prevT = t;
    prevE = curE;
  }

  if (bracketLo === null || bracketHi === null) {
    return {
      totalDurationMin: bestFallbackT,
      targetFraction: sustainableFraction(bestFallbackT, inputs.ceilingParams),
      result: bestFallbackResult,
      selfConsistent: false,
    };
  }

  let lo = bracketLo;
  let hi = bracketHi;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const midE = actualMinutesFor(mid).minutes - mid;
    if (midE > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const finalT = (lo + hi) / 2;
  return {
    totalDurationMin: finalT,
    targetFraction: sustainableFraction(finalT, inputs.ceilingParams),
    result: actualMinutesFor(finalT).result,
    selfConsistent: true,
  };
}
