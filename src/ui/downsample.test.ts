import { describe, expect, it } from "vitest";
import { downsample } from "./downsample";

describe("downsample", () => {
  it("returns the series unchanged if already within the limit", () => {
    const series = [1, 2, 3];
    expect(downsample(series, 800)).toEqual(series);
  });

  it("reduces to at most maxPoints+1 (last point always kept)", () => {
    const series = Array.from({ length: 5000 }, (_, i) => i);
    const result = downsample(series, 800);
    expect(result.length).toBeLessThanOrEqual(801);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(4999);
  });
});
