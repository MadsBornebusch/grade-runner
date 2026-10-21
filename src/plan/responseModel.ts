// PLAN.md §15 layer 3: how much does this athlete's fitness index respond
// to a change in training load? One number per athlete, the elasticity:
// the % change in the index between two adjacent blocks per % change in
// chronic load. It is shrunk toward a prior, so with little data the plan
// follows the prior ramp and only moves off it as evidence accumulates. No
// EWMA time constant is fitted (§12 Q3: not identifiable).

export interface Reading {
  /** Days since 1970-01-01. */
  day: number;
  value: number;
}

export interface Block {
  /** First day of the block (inclusive). */
  start: number;
  end: number;
  n: number;
  /** Mean of log(value). */
  meanLog: number;
}

/** Consecutive `blockDays` blocks from `from`, each with its readings'
 * mean log value; blocks with fewer than `minReadings` are kept with n so a
 * caller can see the gaps. */
export function blocksOf(readings: Reading[], from: number, to: number, blockDays: number): Block[] {
  const out: Block[] = [];
  for (let start = from; start <= to; start += blockDays) {
    const xs = readings.filter((r) => r.day >= start && r.day < start + blockDays);
    out.push({ start, end: start + blockDays, n: xs.length, meanLog: xs.reduce((s, r) => s + Math.log(r.value), 0) / Math.max(1, xs.length) });
  }
  return out;
}

export interface BlockPair {
  earlier: Block;
  later: Block;
  /** log(mean chronic load in later / in earlier). */
  ramp: number;
  /** later.meanLog - earlier.meanLog. */
  change: number;
  /** Sampling variance of `change`. */
  variance: number;
}

/**
 * Adjacent blocks that both have at least `minReadings`. `meanChronic(start,
 * end)` is the mean chronic load over [start, end). `perReadingSd` is one
 * reading's spread around its block's level, in log units.
 */
export function adjacentPairs(
  blocks: Block[],
  meanChronic: (start: number, end: number) => number,
  minReadings: number,
  perReadingSd: number,
): BlockPair[] {
  const out: BlockPair[] = [];
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.n < minReadings || b.n < minReadings) continue;
    const ca = meanChronic(a.start, a.end);
    const cb = meanChronic(b.start, b.end);
    if (!(ca > 0 && cb > 0)) continue;
    out.push({
      earlier: a, later: b, ramp: Math.log(cb / ca), change: b.meanLog - a.meanLog,
      variance: perReadingSd * perReadingSd * (1 / a.n + 1 / b.n),
    });
  }
  return out;
}

export interface Prior {
  mean: number;
  sd: number;
}

export interface Posterior {
  mean: number;
  sd: number;
}

/**
 * Gaussian prior on the elasticity times a weighted Gaussian likelihood of
 * change = elasticity x ramp over `pairs` (no intercept: no ramp, no
 * expected change). Each pair is weighted 0.5^(age / halfLifeDays), age
 * from its later block's end to `asOfDay`, so old blocks count less.
 */
export function posteriorElasticity(pairs: BlockPair[], prior: Prior, asOfDay: number, halfLifeDays: number): Posterior {
  let precision = 1 / (prior.sd * prior.sd);
  let weightedMean = prior.mean * precision;
  for (const p of pairs) {
    const w = 0.5 ** (Math.max(0, asOfDay - p.later.end) / halfLifeDays);
    precision += (w * p.ramp * p.ramp) / p.variance;
    weightedMean += (w * p.ramp * p.change) / p.variance;
  }
  return { mean: weightedMean / precision, sd: Math.sqrt(1 / precision) };
}

export interface WalkForwardPrediction {
  pair: BlockPair;
  /** Number of earlier pairs the fit could use. */
  trainedOn: number;
  noChange: number;
  prior: number;
  fitted: number;
  posterior: Posterior;
}

/**
 * Predicts each pair's change from only the pairs whose later block ended
 * before this pair's later block starts (so neither the outcome nor any
 * reading it shares leaks in). Pairs must be in time order.
 */
export function walkForward(pairs: BlockPair[], prior: Prior, halfLifeDays: number): WalkForwardPrediction[] {
  return pairs.map((pair) => {
    const past = pairs.filter((q) => q.later.end <= pair.later.start);
    const posterior = posteriorElasticity(past, prior, pair.later.start, halfLifeDays);
    return { pair, trainedOn: past.length, noChange: 0, prior: prior.mean * pair.ramp, fitted: posterior.mean * pair.ramp, posterior };
  });
}
