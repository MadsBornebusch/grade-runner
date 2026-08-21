// Pacing-margin curve: how much of the athlete's fitted aerobic ceiling
// (tau/f0/fInf, already decaying with elapsed time WITHIN a race) they
// actually choose to use, as a function of the RACE'S OWN total duration.
//
// This exists because findSustainableTheta's zero-margin search -- the
// largest theta that avoids bonking across the whole course -- was shown
// (this session, real data) to systematically overpredict pace: for every
// race under ~6-8h, the glycogen/fuel constraint never even binds, so the
// search just returns theta=1 (100% of the fitted ceiling) with no other
// limit applied at all. Real races don't happen at theta=1 -- heart-rate-
// implied "chosen theta" (computeChosenTheta below, from the same HR-power
// calibration hrCalibration.ts already fits) averaged 0.75-0.96 for the
// athlete's own short races and 0.52-0.75 for their several-hour ones, a
// real, duration-dependent gap theta=1 can't see because nothing in the
// model besides fuel ever pulls it down.
//
// Fit ONLY from user-confirmed races (StoredRun.raceTag === "race"), never
// from the general pool a name heuristic would guess at -- a real check
// this session found a non-generic-name heuristic misclassified a club
// interval session as a race and would have conflated a backyard-ultra
// loop format (enforced rest every hour, not a continuous effort) with a
// real one. With as few as 4-8 confirmed races behind this fit, getting
// that one label right matters far more than it does for the "pool
// everything, duration alone gates it" fits elsewhere in this file's
// sibling, pacingFit.ts.
//
// Functional form: same asymptotic-decay shape sustainableFraction() uses
// for the WITHIN-race curve (f0 -> fInf as elapsed time grows), reused here
// for a conceptually different question (chosen effort vs. THIS RACE'S OWN
// total duration, across races) -- marginF0 is fixed at 1.0 (a very short
// race needs essentially no margin; PLAN.md's own real-data check found a
// 42-minute race's chosen theta at 0.96, close to that anchor) rather than
// freely fit, leaving marginFInf/marginTauHours as the only two free
// parameters -- appropriate given how few confirmed races most athletes
// will have.

import type { CeilingParams } from "./ceiling";
import { ceilingPower } from "./ceiling";
import { EARLY_WINDOW_FRACTION, predictPowerFromHr, type HrPowerCalibration } from "./hrCalibration";
import type { EffortTrendPoint } from "./pacingFit";

/** Below this many confirmed races, a 2-parameter curve isn't meaningfully
 * constrained -- return null (same "no data" convention as every other fit
 * in this codebase) rather than a number that looks precise but rests on
 * almost nothing. */
export const MIN_MARGIN_FIT_RACES = 4;

export interface PacingMarginRacePoint {
  name: string;
  durationHours: number;
  chosenTheta: number | null;
  predictedTheta: number | null;
  residual: number | null;
}

export interface PacingMarginFitResult {
  marginFInf: number;
  marginTauHours: number;
  raceCount: number;
  minDurationHours: number;
  maxDurationHours: number;
  /** Largest OBSERVED (chosen - predicted) residual, floored at 0 -- the
   * "best demonstrated" upside band above the fitted curve (see
   * predictBestDemonstratedTheta). Built from whichever confirmed race most
   * exceeded what the curve expected for its own duration, not a fantasy
   * ceiling -- something this athlete has actually done. */
  bestUpsideOffset: number;
  perRace: PacingMarginRacePoint[];
}

/** Duration-weighted mean HR-implied effort fraction (theta -- power over
 * the ceiling AT that point in time) over a race's own early (trusted)
 * window -- same restriction and same reasoning as hrCalibration.ts's own
 * fitting (cardiac drift makes late-race HR read artificially high
 * relative to true power). The HR-power calibration predicts absolute
 * power, not a ceiling-relative fraction (see hrCalibration.ts's header
 * doc for why), so this divides by each point's own ceiling to get theta --
 * the quantity this margin curve is fit in terms of. Returns null if the
 * race has no HR data at all in that window. */
export function computeChosenTheta(race: EffortTrendPoint[], calibration: HrPowerCalibration, ceilingParams: CeilingParams): number | null {
  if (race.length === 0) return null;
  const totalHours = Math.max(...race.map((p) => p.tHours + p.dtS / 3600));
  if (!(totalHours > 0)) return null;
  const cutoffHours = totalHours * EARLY_WINDOW_FRACTION;

  let weightedSum = 0;
  let weightedWeight = 0;
  for (const p of race) {
    if (p.tHours >= cutoffHours) continue;
    if (p.heartRateBpm === undefined) continue;
    const ceiling = ceilingPower({ tMin: p.tHours * 60, altitudeM: p.altitudeM, elapsedHours: p.tHours }, ceilingParams);
    if (ceiling <= 0) continue;
    const powerWPerKg = predictPowerFromHr(p.heartRateBpm, calibration);
    const effortFraction = powerWPerKg / ceiling;
    weightedSum += effortFraction * p.dtS;
    weightedWeight += p.dtS;
  }
  return weightedWeight > 0 ? weightedSum / weightedWeight : null;
}

function predictMarginThetaRaw(durationHours: number, marginFInf: number, marginTauHours: number): number {
  return marginFInf + (1 - marginFInf) * Math.exp(-durationHours / marginTauHours);
}

/**
 * Fits marginFInf/marginTauHours from user-confirmed races only. `races`
 * and `names`/`raceDates` are parallel arrays; a race whose chosen theta
 * can't be computed (no HR data in its early window) is reported in
 * `perRace` with null fields but excluded from the fit itself.
 */
export function fitPacingMarginAcrossRaces(
  races: EffortTrendPoint[][],
  names: string[],
  calibration: HrPowerCalibration,
  ceilingParams: CeilingParams,
): PacingMarginFitResult | null {
  const points = races.map((race, i) => {
    const totalHours = race.length > 0 ? Math.max(...race.map((p) => p.tHours + p.dtS / 3600)) : 0;
    const chosenTheta = computeChosenTheta(race, calibration, ceilingParams);
    return { name: names[i] ?? `race ${i + 1}`, durationHours: totalHours, chosenTheta };
  });

  const usable = points.filter((p): p is { name: string; durationHours: number; chosenTheta: number } => p.chosenTheta !== null && p.durationHours > 0);
  if (usable.length < MIN_MARGIN_FIT_RACES) return null;

  const sse = (marginFInf: number, marginTauHours: number): number =>
    usable.reduce((s, p) => s + (predictMarginThetaRaw(p.durationHours, marginFInf, marginTauHours) - p.chosenTheta) ** 2, 0);

  // Coarse-then-fine grid search, same discipline as this file's siblings
  // (e.g. fitUnpavedCostMultiplierAcrossRaces) -- cheap here (no solver
  // simulation per candidate, just arithmetic over a handful of races), so
  // a fairly fine coarse pass is affordable.
  const search = (fInfRange: [number, number], tauRange: [number, number], fInfStep: number, tauStep: number) => {
    let best = { marginFInf: fInfRange[0], marginTauHours: tauRange[0], err: Infinity };
    for (let fInf = fInfRange[0]; fInf <= fInfRange[1]; fInf += fInfStep) {
      for (let tau = tauRange[0]; tau <= tauRange[1]; tau += tauStep) {
        const err = sse(fInf, tau);
        if (err < best.err) best = { marginFInf: fInf, marginTauHours: tau, err };
      }
    }
    return best;
  };

  const coarse = search([0.15, 0.95], [0.1, 48], 0.02, 0.2);
  const fine = search(
    [Math.max(0.1, coarse.marginFInf - 0.02), Math.min(0.98, coarse.marginFInf + 0.02)],
    [Math.max(0.05, coarse.marginTauHours - 0.2), coarse.marginTauHours + 0.2],
    0.001,
    0.01,
  );

  const perRace: PacingMarginRacePoint[] = points.map((p) => {
    if (p.chosenTheta === null || p.durationHours <= 0) {
      return { name: p.name, durationHours: p.durationHours, chosenTheta: p.chosenTheta, predictedTheta: null, residual: null };
    }
    const predictedTheta = predictMarginThetaRaw(p.durationHours, fine.marginFInf, fine.marginTauHours);
    return { name: p.name, durationHours: p.durationHours, chosenTheta: p.chosenTheta, predictedTheta, residual: p.chosenTheta - predictedTheta };
  });

  const bestUpsideOffset = Math.max(0, ...perRace.map((p) => p.residual ?? 0));
  const durations = usable.map((p) => p.durationHours);

  return {
    marginFInf: fine.marginFInf,
    marginTauHours: fine.marginTauHours,
    raceCount: usable.length,
    minDurationHours: Math.min(...durations),
    maxDurationHours: Math.max(...durations),
    bestUpsideOffset,
    perRace,
  };
}

/** The subset of PacingMarginFitResult predictMarginTheta/
 * predictBestDemonstratedTheta actually need -- lets a caller (formInputs.ts's
 * persisted `pacingMargin`) store just these three numbers rather than the
 * full fit result (raceCount/coverage/perRace are ephemeral UI-display data,
 * reconstructed by RunLibraryPanel each time it fits, not persisted). A full
 * PacingMarginFitResult satisfies this structurally, no conversion needed. */
export interface PacingMarginCurve {
  marginFInf: number;
  marginTauHours: number;
  bestUpsideOffset: number;
}

/** Evaluates the fitted margin curve at an arbitrary duration, clamped to
 * [0, 1] -- a candidate finish-time duration outside
 * [minDurationHours, maxDurationHours] is an EXTRAPOLATION past what any
 * confirmed race actually tested; callers that show this number should
 * flag that (see PacingMarginFitResult's own coverage fields). */
export function predictMarginTheta(durationHours: number, curve: PacingMarginCurve): number {
  return Math.min(1, Math.max(0, predictMarginThetaRaw(durationHours, curve.marginFInf, curve.marginTauHours)));
}

/** The margin curve's own upper edge -- this athlete's best-demonstrated
 * execution relative to what the curve expects at that duration, not a
 * theoretical/never-achieved number. Still clipped at 1 (can't exceed the
 * zero-margin ceiling regardless of how large bestUpsideOffset is). */
export function predictBestDemonstratedTheta(durationHours: number, curve: PacingMarginCurve): number {
  return Math.min(1, predictMarginTheta(durationHours, curve) + curve.bestUpsideOffset);
}
