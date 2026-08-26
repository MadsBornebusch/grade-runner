import type { ChartPoint } from "./chartData";

export interface Split {
  index: number;
  startKm: number;
  endKm: number;
  elevationGainM: number;
  elevationLossM: number;
  timeS: number;
  cumulativeTimeS: number;
  avgSpeedMs: number;
  mode: "run" | "walk" | "mixed";
  /** Time-weighted average of estimatedHeartRateBpm across this split's
   * points -- null if no calibration is applied (every point in the split
   * is null), same "no data, not zero" convention as ChartPoint's own
   * field. */
  avgEstimatedHeartRateBpm: number | null;
  /** Carbs to consume via intake during this split, grams -- intakeGPerH
   * held flat x this split's own timeS, NOT total carb burned/oxidized
   * (which also draws on glycogen stores whenever demand exceeds intake --
   * see substrate.ts's stepGlycogen: carbInOxGPerS is intakeGPerH/3600
   * regardless of demand). This is "how much to actually eat/drink before
   * the next stop," the number an aid-station plan needs -- burned-carb
   * total would overstate it by whatever the body pulls from its own
   * glycogen reserve instead of from what was eaten. */
  intakeCarbG: number;
  /** Running total at this split's end -- lets a caller check total fueling
   * budget without summing intakeCarbG across every prior row itself. */
  cumulativeIntakeCarbG: number;
}

/** Shared aggregation core for both computeSplits (fixed-distance buckets)
 * and computeCustomSplits (arbitrary boundaries, e.g. user-placed aid
 * stations) -- boundaryKm is every split's own END distance, ascending,
 * with the course's own final distance always last (a boundary at or past
 * the course end is a no-op: the two-pointer walk below can never advance
 * past the last point anyway). */
function computeSplitsAtBoundaries(points: ChartPoint[], boundaryKm: number[], intakeGPerH: number): Split[] {
  if (points.length === 0 || boundaryKm.length === 0) return [];

  const deltas = points.map((p, i) => (i === 0 ? 0 : p.elevationM - points[i - 1].elevationM));
  const splits: Split[] = [];
  let bucketStartIdx = 0;
  let prevCumulativeTimeS = 0;
  let prevEndKm = 0;
  let cumulativeIntakeCarbG = 0;

  const flush = (endIdx: number) => {
    let gain = 0;
    let loss = 0;
    let hrWeightedSum = 0;
    let hrWeightSum = 0;
    let prevPointTimeS = prevCumulativeTimeS;
    for (let i = bucketStartIdx; i <= endIdx; i++) {
      const d = deltas[i];
      if (d > 0) gain += d;
      else loss += -d;
      const pointDtS = points[i].cumulativeTimeS - prevPointTimeS;
      if (points[i].estimatedHeartRateBpm !== null) {
        hrWeightedSum += points[i].estimatedHeartRateBpm! * pointDtS;
        hrWeightSum += pointDtS;
      }
      prevPointTimeS = points[i].cumulativeTimeS;
    }
    const last = points[endIdx];
    const timeS = last.cumulativeTimeS - prevCumulativeTimeS;
    const distanceKm = last.distanceKm - prevEndKm;
    const modes = new Set(points.slice(bucketStartIdx, endIdx + 1).map((p) => p.mode));
    const intakeCarbG = intakeGPerH * (timeS / 3600);
    cumulativeIntakeCarbG += intakeCarbG;

    splits.push({
      index: splits.length,
      startKm: prevEndKm,
      endKm: last.distanceKm,
      elevationGainM: gain,
      elevationLossM: loss,
      timeS,
      cumulativeTimeS: last.cumulativeTimeS,
      avgSpeedMs: distanceKm > 0 ? (distanceKm * 1000) / timeS : 0,
      mode: modes.size === 1 ? [...modes][0] : "mixed",
      avgEstimatedHeartRateBpm: hrWeightSum > 0 ? hrWeightedSum / hrWeightSum : null,
      intakeCarbG,
      cumulativeIntakeCarbG,
    });

    prevCumulativeTimeS = last.cumulativeTimeS;
    prevEndKm = last.distanceKm;
  };

  for (const boundary of boundaryKm) {
    let endIdx = bucketStartIdx;
    while (endIdx + 1 < points.length && points[endIdx + 1].distanceKm <= boundary) endIdx++;
    flush(endIdx);
    bucketStartIdx = endIdx + 1;
    if (bucketStartIdx >= points.length) break;
  }

  return splits;
}

/** Aggregates per-segment chart points into fixed-distance splits for the
 * split table. intakeGPerH (default 0 -- no carb column) drives each
 * split's intakeCarbG; pass the athlete's own planned fueling rate
 * (formInputs.intakeGPerH) to show it. */
export function computeSplits(points: ChartPoint[], splitLengthKm = 1, intakeGPerH = 0): Split[] {
  if (points.length === 0) return [];
  const totalKm = points[points.length - 1].distanceKm;
  const boundaryKm: number[] = [];
  for (let b = splitLengthKm; b < totalKm; b += splitLengthKm) boundaryKm.push(b);
  boundaryKm.push(totalKm);
  return computeSplitsAtBoundaries(points, boundaryKm, intakeGPerH);
}

/**
 * Splits between arbitrary user-chosen distances instead of a fixed
 * interval -- e.g. points saved from RouteMap.tsx, for planning legs
 * between aid stations rather than uniform km markers. Always ends at the
 * course's own final distance regardless of whether that's in `atKm`, and
 * silently drops any boundary at or beyond the course end (nothing left to
 * split there) or at/before the start (an empty leading leg).
 */
export function computeCustomSplits(points: ChartPoint[], atKm: number[], intakeGPerH = 0): Split[] {
  if (points.length === 0) return [];
  const totalKm = points[points.length - 1].distanceKm;
  const boundaryKm = [...new Set(atKm.filter((km) => km > 0 && km < totalKm))].sort((a, b) => a - b);
  boundaryKm.push(totalKm);
  return computeSplitsAtBoundaries(points, boundaryKm, intakeGPerH);
}
