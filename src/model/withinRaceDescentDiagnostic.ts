// Within-race redesign of the descent diagnostic (see raceDiagnosticPoint.ts
// and tauDiagnostic.ts for the whole-race version this complements, not
// replaces). Motivation: eccentric-loading muscle damage from a fast
// downhill should show up as degraded fade in whatever comes *after* it,
// not smeared into a race-wide average -- a race with fast descent at km 2
// followed by 30km of flat terrain should show its damage in that flat
// section's own decay, which a race-average descent metric can't see at
// all. Few real races have the ideal shape to test this via a *whole-race*
// comparison (fast descent concentrated early, substantial distance
// remaining after), so that cross-race approach is close to blind to a
// real effect even if one exists.
//
// The fix: stop comparing whole races to each other; compare each race's
// own late behavior to its own early behavior. Split each race in two.
// Early portion: how much fast descent happened. Late portion: does its
// own decay exceed what the race's already-fitted single tau would
// predict -- a residual, not a second noisy tau fit. Correlate the two
// within-race quantities across races. This works with any race that has
// *some* early descent -- it doesn't need a specially-shaped race, since
// the comparison is internal to each race, not between races.
//
// PLAN.md §14 Plan B, Stage 4: also carries two aerobic-fatigue-clock
// candidates from the §14 shortlist -- early-window cumulative Minetti net
// locomotion work and early-window cumulative supra-LT2 "hard" work
// (workAccumulation.ts), normalized the same per-km way as the descent
// metrics -- so the SAME late-window residual outcome used to judge the
// impact/muscular-fatigue candidates below also judges these two head to
// head against elapsed time (already implicitly "tested" by construction,
// since lateResidualTrendPctPerHour is itself the residual left over AFTER
// removing a single elapsed-time-based tau decay -- a strong net/hard-work
// correlation here would say elapsed time isn't the whole story, not that
// time is irrelevant).
//
// IMPORTANT caveat, not shared by the descent/running-impact predictors:
// both net work and hard work are Minetti-cost-curve-derived from GPS
// speed+grade -- the exact same basis as grossPowerWPerKg, the numerator of
// the effortFraction this file's residual is built from (see analysis.ts).
// A run paced aggressively early and slower late (an ordinary negative-split
// shape, nothing pathological) will mechanically show BOTH high early
// cumulative work/hard-work AND a more negative late residual, since faster
// early pace is exactly what produces both numbers. So a positive
// correlation here does not distinguish "cumulative work is the real
// fatigue clock" from "this run happened to be paced hard early" -- unlike
// heart rate in Stage 3, this isn't an independent instrument reading.
// Read as a candidate worth carrying into Stage 5's held-out backtest, not
// as standalone evidence.
//
// Also carries runningImpact.ts's fitted "running impact" score as a fourth
// early-window predictor, for a head-to-head comparison against the three
// descent-specific ones. Its distance term does NOT make this predictor
// distance-collinear the way it might look: per-km normalization divides it
// out to a constant (runningImpact(early)/earlyDistanceKm reduces exactly to
// `distanceCoefficient + hillSurchargeCoefficient * (hillSurchargeKm /
// earlyDistanceKm)`), and a Pearson correlation is invariant to adding a
// constant -- so earlyRunningImpactPerKm is driven entirely by early-window
// grade cost, a pure terrain-difficulty signal, not a time/distance proxy.
// The real caveat is different: it lumps ascent+flat+descent into one
// number (and, per runningImpact.ts's own module comment, has the *wrong
// sign* for descent specifically -- gentle-to-moderate descent scores lower
// on this metric, not higher, since it's built on Minetti metabolic cost
// rather than an eccentric-damage model), whereas the hypothesis this
// diagnostic exists to test is specifically about descent. A correlation
// here reflects general early-race terrain difficulty, not an isolated
// descent effect; it clears the same bar as the descent metrics (does the
// *late-window residual*, not raw fade, correlate) but should be read as a
// less targeted probe, not a replacement.

import { analyzeRun } from "./analysis";
import { descentImpact, descentImpactSquared, descentMeters } from "./descentImpact";
import type { PipelineResult } from "../gpx/pipeline";
import {
  buildEffortTrendPoints,
  computeEffortTrend,
  fitTauMinutes,
  MIN_FIT_POINTS,
  trimForPacingFit,
} from "./pacingFit";
import { runningImpact } from "./runningImpact";
import { pearsonCorrelation } from "./tauDiagnostic";
import { hardWorkJPerKg, netLocomotionWorkJPerKg } from "./workAccumulation";
import type { BuildRaceDiagnosticPointOptions } from "./raceDiagnosticPoint";

/** Simplest defensible default -- a tunable parameter, not a hardcoded
 * assumption. Worth revisiting once real data shows whether 0.5 is too
 * broad (dilutes a genuinely early-only effect) or fine. */
const DEFAULT_EARLY_FRACTION = 0.5;

/** MIN_FIT_POINTS alone isn't enough of a floor: it guards against too few
 * *points* for a numerically stable regression, but says nothing about
 * elapsed *time* -- a short race can clear it with a late window of only
 * ~20 minutes, nowhere near enough time for a real muscular-fatigue effect
 * to develop, yet its resulting residual can still swing wildly (confirmed
 * on real data: two ~20min late windows read -27%/h and -55%/h, dwarfing
 * every other race and dominating a small correlation). Physiologically
 * motivated default, not derived from data. */
const DEFAULT_MIN_LATE_WINDOW_HOURS = 1;

export interface WithinRaceDiagnosticPoint {
  label: string;
  /** The late window's own residual trend, evaluated at the whole race's
   * already-fitted tau -- near zero if a clean single-tau exponential
   * explains the whole race; a real localized-late effect shows up as
   * still-negative residual slope specifically in this window. */
  lateResidualTrendPctPerHour: number;
  /** Descent metrics restricted to the early window only, normalized per
   * km of the early window's own distance (not the whole race), so races
   * of different total length are still comparable on how much fast
   * descent was packed into the early window specifically. */
  earlyDescentPerKm: number;
  earlyDescentImpactPerKm: number;
  earlyDescentImpactSquaredPerKm: number;
  /** runningImpact.ts's fitted score, restricted to the early window and
   * normalized per km the same way as the descent metrics above. See this
   * file's header comment for why it's a weaker, more confounded probe. */
  earlyRunningImpactPerKm: number;
  /** Aerobic-fatigue-clock candidates (PLAN.md §14 Plan B, Stage 4), early
   * window only, normalized per km of the early window's own distance --
   * see this file's header comment for the negative-split confound these
   * two candidates carry that the descent/running-impact ones above don't. */
  earlyNetWorkPerKmJPerKg: number;
  earlyHardWorkPerKmJPerKg: number;
}

export interface WithinRaceDiagnosticResult {
  points: WithinRaceDiagnosticPoint[];
  /**
   * Pearson r between the late-window residual and each early-descent
   * signal. The hypothesis predicts a *negative* correlation -- more early
   * descent (at any speed weighting) going with a more negative late
   * residual (faster-than-modeled decay after the descent) -- not just
   * "any" relationship.
   */
  lateResidualVsEarlyDescentCorrelation: number | null;
  lateResidualVsEarlyDescentImpactCorrelation: number | null;
  lateResidualVsEarlyDescentImpactSquaredCorrelation: number | null;
  lateResidualVsEarlyRunningImpactCorrelation: number | null;
  /** See earlyNetWorkPerKmJPerKg/earlyHardWorkPerKmJPerKg's own doc for the
   * negative-split confound that makes these two harder to read than the
   * four above -- carried into Stage 5's held-out backtest, not concluded from here alone. */
  lateResidualVsEarlyNetWorkCorrelation: number | null;
  lateResidualVsEarlyHardWorkCorrelation: number | null;
}

/**
 * Null under the same conditions raceDiagnosticPoint.ts's builder skips a
 * race for (no timestamps, zero distance, no reliable whole-race tau fit),
 * plus two new ones: the late window needs at least MIN_FIT_POINTS of its
 * own trimmed points *and* at least `minLateWindowHours` of its own
 * elapsed time (see DEFAULT_MIN_LATE_WINDOW_HOURS) to compute a meaningful
 * residual trend -- a point-count floor alone isn't enough, since a short
 * race can clear it with a late window too brief for any real fatigue
 * effect to show up in.
 */
export function buildWithinRaceDiagnosticPoint(
  label: string,
  course: PipelineResult,
  options: BuildRaceDiagnosticPointOptions,
  earlyFraction: number = DEFAULT_EARLY_FRACTION,
  minLateWindowHours: number = DEFAULT_MIN_LATE_WINDOW_HOURS,
): WithinRaceDiagnosticPoint | null {
  if (!course.hasTimestamps) return null;
  const distanceKm = course.totalDistance3D / 1000;
  if (distanceKm <= 0) return null;

  const analysis = analyzeRun(course.segments, options);
  const effortTrendPoints = buildEffortTrendPoints(course.segments, analysis.segments, options.altitudeAdjustment);
  const soloTauFit = fitTauMinutes(effortTrendPoints, options.ceilingParams);
  if (!soloTauFit || soloTauFit.hitSearchBoundary) return null;

  const trimmed = trimForPacingFit(effortTrendPoints);
  if (trimmed.length < MIN_FIT_POINTS) return null;

  const startHours = trimmed[0].tHours;
  const endHours = trimmed[trimmed.length - 1].tHours;
  const splitHours = startHours + earlyFraction * (endHours - startHours);
  if (endHours - splitHours < minLateWindowHours) return null;

  const latePoints = trimmed.filter((p) => p.tHours >= splitHours);
  if (latePoints.length < MIN_FIT_POINTS) return null;

  const lateResidual = computeEffortTrend(latePoints, { ...options.ceilingParams, tauMin: soloTauFit.tauMin });
  if (!lateResidual) return null;

  // Restrict descent metrics to segments whose *cumulative elapsed time*
  // falls before the split point -- not segment count or distance, since
  // pace varies within a race.
  const splitElapsedS = splitHours * 3600;
  let cumulativeElapsedS = 0;
  let earlySegmentCount = course.segments.length;
  for (let i = 0; i < course.segments.length; i++) {
    cumulativeElapsedS += course.segments[i].dtS ?? 0;
    if (cumulativeElapsedS >= splitElapsedS) {
      earlySegmentCount = i + 1;
      break;
    }
  }
  const earlySegments = course.segments.slice(0, earlySegmentCount);
  const earlyDistanceKm = (earlySegments.at(-1)?.cumulativeDistance3D ?? 0) / 1000;
  if (earlyDistanceKm <= 0) return null;

  return {
    label,
    lateResidualTrendPctPerHour: lateResidual.slopePerHour * 100,
    earlyDescentPerKm: descentMeters(earlySegments) / earlyDistanceKm,
    earlyDescentImpactPerKm: descentImpact(earlySegments) / earlyDistanceKm,
    earlyDescentImpactSquaredPerKm: descentImpactSquared(earlySegments) / earlyDistanceKm,
    earlyRunningImpactPerKm: runningImpact(earlySegments) / earlyDistanceKm,
    earlyNetWorkPerKmJPerKg: netLocomotionWorkJPerKg(earlySegments, options.ceilingParams) / earlyDistanceKm,
    earlyHardWorkPerKmJPerKg: hardWorkJPerKg(earlySegments, options.ceilingParams) / earlyDistanceKm,
  };
}

export function computeWithinRaceDescentDiagnostic(points: WithinRaceDiagnosticPoint[]): WithinRaceDiagnosticResult {
  const lateResidualValues = points.map((p) => p.lateResidualTrendPctPerHour);
  return {
    points,
    lateResidualVsEarlyDescentCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyDescentPerKm),
    ),
    lateResidualVsEarlyDescentImpactCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyDescentImpactPerKm),
    ),
    lateResidualVsEarlyDescentImpactSquaredCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyDescentImpactSquaredPerKm),
    ),
    lateResidualVsEarlyRunningImpactCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyRunningImpactPerKm),
    ),
    lateResidualVsEarlyNetWorkCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyNetWorkPerKmJPerKg),
    ),
    lateResidualVsEarlyHardWorkCorrelation: pearsonCorrelation(
      lateResidualValues,
      points.map((p) => p.earlyHardWorkPerKmJPerKg),
    ),
  };
}
