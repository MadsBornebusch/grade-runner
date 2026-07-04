import { describe, expect, it } from "vitest";
import {
  GRADE_CLAMP,
  costOfRunning,
  costOfWalking,
  maxDescentSpeedMs,
} from "./minetti";

describe("costOfRunning", () => {
  it("matches Cr(0) = 3.6", () => {
    expect(costOfRunning(0)).toBeCloseTo(3.6, 6);
  });

  it("has a minimum around i = -0.10 to -0.20", () => {
    const samples = [];
    for (let i = -0.3; i <= 0; i += 0.01) {
      samples.push({ i, cost: costOfRunning(i) });
    }
    const min = samples.reduce((a, b) => (b.cost < a.cost ? b : a));
    expect(min.i).toBeGreaterThanOrEqual(-0.2);
    expect(min.i).toBeLessThanOrEqual(-0.1);
    expect(min.cost).toBeGreaterThan(1.6);
    expect(min.cost).toBeLessThan(1.9);
  });

  it("clamps the polynomial beyond the validated range", () => {
    const atClamp = costOfRunning(GRADE_CLAMP);
    const beyond = costOfRunning(GRADE_CLAMP + 0.2);
    // still uses the clamped polynomial value as a base, plus a surcharge
    expect(beyond).toBeGreaterThan(atClamp);
  });

  it("degrades gracefully (monotonically increasing) past the clamp instead of flat-lining", () => {
    const costs = [0.45, 0.6, 0.8, 1.0, 1.5].map(costOfRunning);
    for (let k = 1; k < costs.length; k++) {
      expect(costs[k]).toBeGreaterThan(costs[k - 1]);
    }
  });

  it("clamps steep descents rather than exploding", () => {
    expect(costOfRunning(-0.6)).toBeCloseTo(costOfRunning(-GRADE_CLAMP), 6);
    expect(costOfRunning(-2)).toBeCloseTo(costOfRunning(-GRADE_CLAMP), 6);
  });
});

describe("costOfWalking", () => {
  it("matches Cw(0) = 2.5", () => {
    expect(costOfWalking(0)).toBeCloseTo(2.5, 6);
  });

  it("is cheaper per meter than running at most gradients", () => {
    for (let i = -0.3; i <= 0.3; i += 0.05) {
      expect(costOfWalking(i)).toBeLessThan(costOfRunning(i));
    }
  });

  it("degrades gracefully past the clamp instead of flat-lining", () => {
    const costs = [0.45, 0.6, 0.8, 1.0].map(costOfWalking);
    for (let k = 1; k < costs.length; k++) {
      expect(costs[k]).toBeGreaterThan(costs[k - 1]);
    }
  });

  it("clamps steep descents rather than exploding", () => {
    expect(costOfWalking(-2)).toBeCloseTo(costOfWalking(-GRADE_CLAMP), 6);
  });
});

describe("maxDescentSpeedMs", () => {
  it("is unlimited on flat, uphill, and mild downhill (above the onset grade)", () => {
    expect(maxDescentSpeedMs(0.1)).toBe(Infinity);
    expect(maxDescentSpeedMs(0)).toBe(Infinity);
    expect(maxDescentSpeedMs(-0.05)).toBe(Infinity);
  });

  it("decreases monotonically as the descent steepens past the onset grade", () => {
    const grades = [-0.1, -0.15, -0.2, -0.25, -0.3, -0.35, -0.4, -0.45];
    const speeds = grades.map(maxDescentSpeedMs);
    for (let k = 1; k < speeds.length; k++) {
      expect(speeds[k]).toBeLessThan(speeds[k - 1]);
    }
  });

  it("clamps beyond the steepest validated grade instead of continuing to fall", () => {
    expect(maxDescentSpeedMs(-0.6)).toBeCloseTo(maxDescentSpeedMs(-GRADE_CLAMP), 6);
    expect(maxDescentSpeedMs(-2)).toBeCloseTo(maxDescentSpeedMs(-GRADE_CLAMP), 6);
  });

  it("stays well below what raw metabolic cost alone would allow at the steepest cheap grades", () => {
    // This is the exact failure mode being fixed: a large power budget divided
    // by Cr(i) near its minimum implies an absurd speed; the cap should hold
    // it to something a person could plausibly control on a technical descent.
    expect(maxDescentSpeedMs(-0.18)).toBeLessThan(4);
  });
});
