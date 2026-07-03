import { describe, expect, it } from "vitest";
import { substrateAnchorsFromThresholds } from "./formInputs";

describe("substrateAnchorsFromThresholds", () => {
  it("matches substrate.ts's own defaults at LT1=0.65/LT2=0.85", () => {
    const { x0, k } = substrateAnchorsFromThresholds(0.65, 0.85);
    expect(x0).toBeCloseTo(0.65, 6);
    expect(k).toBeCloseTo(11.0, 1);
  });
});
