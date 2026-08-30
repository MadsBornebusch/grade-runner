import { describe, expect, it } from "vitest";
import {
  GRADE_CLAMP,
  costOfRunning,
  costOfWalking,
  descentPacingMultiplier,
  gradeAdjustedSpeedMs,
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
  it("is unlimited on flat, uphill, and mild downhill (above the ramp-start grade)", () => {
    expect(maxDescentSpeedMs(0.1)).toBe(Infinity);
    expect(maxDescentSpeedMs(0)).toBe(Infinity);
    expect(maxDescentSpeedMs(-0.03)).toBe(Infinity);
  });

  it("decreases monotonically as the descent steepens past the ramp-start grade", () => {
    const grades = [-0.04, -0.06, -0.08, -0.1, -0.15, -0.2, -0.25, -0.3, -0.35, -0.4, -0.45];
    const speeds = grades.map(maxDescentSpeedMs);
    for (let k = 1; k < speeds.length; k++) {
      expect(speeds[k]).toBeLessThan(speeds[k - 1]);
    }
  });

  it("has no discontinuity at the onset grade -- real terrain crosses it constantly", () => {
    // The exact bug being fixed: a real course's grade oscillates back and
    // forth across a single hard threshold segment to segment, and a step
    // discontinuity there made predicted pace slam between uncapped and
    // hard-capped every other segment. A small step on either side of the
    // onset grade should now produce a comparably small change in speed
    // (unlike the old behavior, where this exact check would have failed
    // by ~2.7 m/s -- the whole Infinity-to-2.8 jump landing in one step).
    const eps = 0.0005;
    const onsetGrade = -0.1;
    const justAbove = maxDescentSpeedMs(onsetGrade + eps);
    const at = maxDescentSpeedMs(onsetGrade);
    const justBelow = maxDescentSpeedMs(onsetGrade - eps);
    expect(Math.abs(justAbove - at)).toBeLessThan(0.1);
    expect(Math.abs(at - justBelow)).toBeLessThan(0.1);
  });

  it("ramps gradually between the ramp-start and onset grades instead of jumping straight to the onset speed", () => {
    // A grade halfway through the ramp should sit meaningfully between the
    // ramp-start cap (effectively non-binding, ~5.5 m/s) and the onset
    // speed (2.8 m/s) -- not equal to either endpoint.
    const halfway = maxDescentSpeedMs(-0.07);
    expect(halfway).toBeGreaterThan(2.9);
    expect(halfway).toBeLessThan(5.4);
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

  it("is unaffected by totalDistanceKm on flat/uphill/mild-downhill (still Infinity)", () => {
    expect(maxDescentSpeedMs(0.1, 10)).toBe(Infinity);
    expect(maxDescentSpeedMs(-0.03, 200)).toBe(Infinity);
  });

  it("omitting totalDistanceKm is byte-for-byte identical to the grade-only cap", () => {
    for (const grade of [-0.1, -0.2, -0.3]) {
      expect(maxDescentSpeedMs(grade, undefined)).toBe(maxDescentSpeedMs(grade));
    }
  });

  it("scales the grade-only cap up for a short race and down for a long one", () => {
    const gradeOnly = maxDescentSpeedMs(-0.15);
    const short = maxDescentSpeedMs(-0.15, 10);
    const long = maxDescentSpeedMs(-0.15, 150);
    expect(short).toBeGreaterThan(gradeOnly);
    expect(long).toBeLessThan(gradeOnly);
    expect(long).toBeLessThan(short);
  });
});

describe("descentPacingMultiplier", () => {
  it("is 1 for zero, negative, or non-finite distance (no scaling applied)", () => {
    expect(descentPacingMultiplier(0)).toBe(1);
    expect(descentPacingMultiplier(-5)).toBe(1);
    expect(descentPacingMultiplier(NaN)).toBe(1);
  });

  it("decreases monotonically as total distance grows", () => {
    const distances = [5, 10, 20, 40, 80, 100, 150, 200];
    const multipliers = distances.map(descentPacingMultiplier);
    for (let k = 1; k < multipliers.length; k++) {
      expect(multipliers[k]).toBeLessThan(multipliers[k - 1]);
    }
  });

  it("is above 1 for a short race and below 1 for a long one, matching the real fit data it's calibrated from", () => {
    // scripts/fitDescentPacingMultiplier.ts: 10.2km real ratio 1.12,
    // 113.2km real ratio 0.57 -- not asserting the exact fitted numbers
    // here (that's the fit script's job), just the qualitative shape a
    // regression on these constants should never invert.
    expect(descentPacingMultiplier(10)).toBeGreaterThan(1);
    expect(descentPacingMultiplier(110)).toBeLessThan(0.7);
  });

  it("converges to a stable floor rather than continuing to fall for an absurdly long extrapolated distance", () => {
    // The exponential decay's fInf asymptote -- an extrapolation guard by
    // construction, not a separate clamp: a 1000km "race" shouldn't produce
    // a multiplier meaningfully different from a 500km one.
    const far = descentPacingMultiplier(500);
    const fartherStill = descentPacingMultiplier(5000);
    expect(Math.abs(far - fartherStill)).toBeLessThan(0.01);
  });
});

describe("gradeAdjustedSpeedMs", () => {
  it("equals the actual speed on flat ground, for either gait", () => {
    expect(gradeAdjustedSpeedMs(3, 0, "run")).toBeCloseTo(3, 6);
    expect(gradeAdjustedSpeedMs(1.5, 0, "walk")).toBeCloseTo(1.5, 6);
  });

  it("reads faster than actual speed on an uphill (the effort would go further on flat)", () => {
    expect(gradeAdjustedSpeedMs(2, 0.1, "run")).toBeGreaterThan(2);
  });

  it("reads slower than actual speed on a moderate downhill (the pace overstates the effort)", () => {
    expect(gradeAdjustedSpeedMs(3, -0.05, "run")).toBeLessThan(3);
  });

  it("uses the walking cost curve for a walked segment, not the running one", () => {
    const runGap = gradeAdjustedSpeedMs(1.5, 0.15, "run");
    const walkGap = gradeAdjustedSpeedMs(1.5, 0.15, "walk");
    expect(runGap).not.toBeCloseTo(walkGap, 3);
  });
});
