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
  /** Carbohydrate burned during this split alone, grams -- last point's
   * cumulativeCarbG minus the previous split's, the same delta-from-running-
   * total idea timeS/distanceKm already use. For aid-station fueling
   * planning: "how much do I need to have eaten by the time I reach the
   * NEXT stop." */
  carbG: number;
  /** Running total at this split's end -- lets a caller check total fueling
   * budget (e.g. against planned intake rate x elapsed hours) without
   * summing carbG across every prior row itself. */
  cumulativeCarbG: number;
}

/** Shared aggregation core for both computeSplits (fixed-distance buckets)
 * and computeCustomSplits (arbitrary boundaries, e.g. user-placed aid
 * stations) -- boundaryKm is every split's own END distance, ascending,
 * with the course's own final distance always last (a boundary at or past
 * the course end is a no-op: the two-pointer walk below can never advance
 * past the last point anyway). */
function computeSplitsAtBoundaries(points: ChartPoint[], boundaryKm: number[]): Split[] {
  if (points.length === 0 || boundaryKm.length === 0) return [];

  const deltas = points.map((p, i) => (i === 0 ? 0 : p.elevationM - points[i - 1].elevationM));
  const splits: Split[] = [];
  let bucketStartIdx = 0;
  let prevCumulativeTimeS = 0;
  let prevEndKm = 0;
  let prevCumulativeCarbG = 0;

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
      carbG: last.cumulativeCarbG - prevCumulativeCarbG,
      cumulativeCarbG: last.cumulativeCarbG,
    });

    prevCumulativeTimeS = last.cumulativeTimeS;
    prevEndKm = last.distanceKm;
    prevCumulativeCarbG = last.cumulativeCarbG;
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

/** Aggregates per-segment chart points into fixed-distance splits for the split table. */
export function computeSplits(points: ChartPoint[], splitLengthKm = 1): Split[] {
  if (points.length === 0) return [];
  const totalKm = points[points.length - 1].distanceKm;
  const boundaryKm: number[] = [];
  for (let b = splitLengthKm; b < totalKm; b += splitLengthKm) boundaryKm.push(b);
  boundaryKm.push(totalKm);
  return computeSplitsAtBoundaries(points, boundaryKm);
}

/**
 * Splits between arbitrary user-chosen distances instead of a fixed
 * interval -- e.g. points saved from RouteMap.tsx, for planning legs
 * between aid stations rather than uniform km markers. Always ends at the
 * course's own final distance regardless of whether that's in `atKm`, and
 * silently drops any boundary at or beyond the course end (nothing left to
 * split there) or at/before the start (an empty leading leg).
 */
export function computeCustomSplits(points: ChartPoint[], atKm: number[]): Split[] {
  if (points.length === 0) return [];
  const totalKm = points[points.length - 1].distanceKm;
  const boundaryKm = [...new Set(atKm.filter((km) => km > 0 && km < totalKm))].sort((a, b) => a - b);
  boundaryKm.push(totalKm);
  return computeSplitsAtBoundaries(points, boundaryKm);
}
