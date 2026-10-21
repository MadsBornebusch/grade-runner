import { describe, expect, it } from "vitest";
import { adjacentPairs, blocksOf, posteriorElasticity, walkForward, type BlockPair } from "./responseModel";

const block = (start: number, n = 5) => ({ start, end: start + 42, n, meanLog: 0 });
const pair = (start: number, ramp: number, change: number, variance = 0.001): BlockPair => ({
  earlier: block(start - 42), later: block(start), ramp, change, variance,
});

describe("blocksOf / adjacentPairs", () => {
  it("pairs only adjacent blocks that both have enough readings", () => {
    const readings = [
      ...[1, 5, 9].map((d) => ({ day: d, value: 10 })),
      ...[43, 47, 50].map((d) => ({ day: d, value: 11 })),
      { day: 90, value: 12 },
      ...[130, 131, 132].map((d) => ({ day: d, value: 12 })),
    ];
    const blocks = blocksOf(readings, 0, 140, 42);
    expect(blocks.map((b) => b.n)).toEqual([3, 3, 1, 3]);
    const pairs = adjacentPairs(blocks, (s) => (s < 42 ? 100 : 120), 3, 0.05);
    expect(pairs.length).toBe(1);
    expect(pairs[0].change).toBeCloseTo(Math.log(1.1), 9);
    expect(pairs[0].ramp).toBeCloseTo(Math.log(1.2), 9);
    expect(pairs[0].variance).toBeCloseTo(0.0025 * (2 / 3), 9);
  });
});

describe("posteriorElasticity", () => {
  it("returns the prior without data and moves to the data's slope with a lot of it", () => {
    const prior = { mean: 0.1, sd: 0.1 };
    const none = posteriorElasticity([], prior, 0, 75);
    expect(none.mean).toBeCloseTo(0.1, 12);
    expect(none.sd).toBeCloseTo(0.1, 12);
    const many = Array.from({ length: 50 }, (_, k) => pair(42 * (k + 1), k % 2 ? 0.3 : -0.2, (k % 2 ? 0.3 : -0.2) * 0.4, 0.0001));
    const post = posteriorElasticity(many, prior, 42 * 52, 1e9);
    expect(post.mean).toBeCloseTo(0.4, 2);
    expect(post.sd).toBeLessThan(0.02);
  });

  it("weights old pairs down by the half-life", () => {
    const prior = { mean: 0, sd: 10 };
    const old = pair(42, 0.3, 0.3 * 1.0);
    const recent = pair(1000, 0.3, 0.3 * 0.2);
    const near = posteriorElasticity([old, recent], prior, 1042, 75).mean;
    expect(near).toBeLessThan(0.25);
    expect(near).toBeGreaterThan(0.2);
  });
});

describe("walkForward", () => {
  it("never uses a pair whose later block overlaps the one predicted", () => {
    const pairs = [pair(42, 0.2, 0.04), pair(84, 0.2, 0.04), pair(126, 0.2, 0.04)];
    const out = walkForward(pairs, { mean: 0.1, sd: 0.1 }, 75);
    expect(out.map((p) => p.trainedOn)).toEqual([0, 1, 2]);
    expect(out[0].fitted).toBeCloseTo(0.02, 9);
    expect(out[2].fitted).toBeGreaterThan(out[1].fitted);
  });
});
