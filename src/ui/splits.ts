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
}

/** Aggregates per-segment chart points into fixed-distance splits for the split table. */
export function computeSplits(points: ChartPoint[], splitLengthKm = 1): Split[] {
  if (points.length === 0) return [];

  const deltas = points.map((p, i) => (i === 0 ? 0 : p.elevationM - points[i - 1].elevationM));
  const splits: Split[] = [];
  let bucketStartIdx = 0;
  let bucketIndex = Math.floor(points[0].distanceKm / splitLengthKm);
  let prevCumulativeTimeS = 0;
  let prevEndKm = 0;

  const flush = (endIdx: number) => {
    let gain = 0;
    let loss = 0;
    for (let i = bucketStartIdx; i <= endIdx; i++) {
      const d = deltas[i];
      if (d > 0) gain += d;
      else loss += -d;
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
    });

    prevCumulativeTimeS = last.cumulativeTimeS;
    prevEndKm = last.distanceKm;
  };

  for (let i = 0; i < points.length; i++) {
    const idx = Math.floor(points[i].distanceKm / splitLengthKm);
    if (idx !== bucketIndex) {
      flush(i - 1);
      bucketStartIdx = i;
      bucketIndex = idx;
    }
  }
  flush(points.length - 1);

  return splits;
}
