// Downsamples a data series for chart rendering while keeping the full-res
// data available for math elsewhere (PLAN.md §3: "downsample rendered series
// to ~800 pts; keep full-res data for math").

export function downsample<T>(series: T[], maxPoints = 800): T[] {
  if (series.length <= maxPoints) return series;
  const stride = series.length / maxPoints;
  const result: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(series[Math.floor(i * stride)]);
  }
  const last = series[series.length - 1];
  if (result[result.length - 1] !== last) result.push(last);
  return result;
}
