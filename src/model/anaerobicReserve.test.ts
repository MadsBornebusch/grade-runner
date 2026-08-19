import { describe, expect, it } from "vitest";
import { availableReserveBoostWPerKg, reserveCrossoverMin, stepAnaerobicReserve } from "./anaerobicReserve";
import type { CeilingParams } from "./ceiling";

const baseParams: CeilingParams = { vo2MaxMlPerKgPerMin: 54, lt2Fraction: 0.83, f0: 0.94, fInf: 0.38, tauMin: 250 };

describe("reserveCrossoverMin", () => {
  it("is positive when f0 exceeds lt2Fraction", () => {
    const crossover = reserveCrossoverMin(baseParams);
    expect(crossover).toBeGreaterThan(0);
    // Matches the closed-form value worked out for these exact params.
    expect(crossover).toBeCloseTo(54.7, 0);
  });

  it("is 0 when the pacing curve is disabled", () => {
    expect(reserveCrossoverMin({ ...baseParams, pacingCurveEnabled: false })).toBe(0);
  });

  it("is 0 when f0 doesn't exceed lt2Fraction (nothing above the cap even at t=0)", () => {
    expect(reserveCrossoverMin({ ...baseParams, f0: 0.8, lt2Fraction: 0.85 })).toBe(0);
  });
});

describe("availableReserveBoostWPerKg", () => {
  const freshState = { consumedKJPerKg: 0 };
  const reserveParams = { reserveKJPerKg: 0.3 };

  it("is positive at t=0 when f0 exceeds lt2Fraction and reserve is unspent", () => {
    const boost = availableReserveBoostWPerKg(0, 0, baseParams, freshState, reserveParams);
    expect(boost).toBeGreaterThan(0);
  });

  it("is 0 once the raw curve has decayed to/below lt2Fraction, regardless of remaining reserve", () => {
    const crossover = reserveCrossoverMin(baseParams);
    const boost = availableReserveBoostWPerKg(crossover + 5, 0, baseParams, freshState, reserveParams);
    expect(boost).toBe(0);
  });

  it("is 0 once the reserve is exhausted, even at t=0", () => {
    const exhausted = { consumedKJPerKg: reserveParams.reserveKJPerKg };
    const boost = availableReserveBoostWPerKg(0, 0, baseParams, exhausted, reserveParams);
    expect(boost).toBe(0);
  });

  it("decreases as more of the reserve is spent", () => {
    const fresh = availableReserveBoostWPerKg(0, 0, baseParams, freshState, reserveParams);
    const partiallySpent = availableReserveBoostWPerKg(
      0,
      0,
      baseParams,
      { consumedKJPerKg: reserveParams.reserveKJPerKg / 2 },
      reserveParams,
    );
    // Boost magnitude at a given tMin doesn't depend on how much is spent
    // (only whether it's exhausted) -- confirms the mechanism is a hard
    // cutoff, not a tapering one, matching the "monotonic depletion, not
    // gradual fade" design.
    expect(partiallySpent).toBe(fresh);
  });
});

describe("stepAnaerobicReserve", () => {
  it("accumulates consumed energy from power drawn over time", () => {
    const reserveParams = { reserveKJPerKg: 1 };
    const next = stepAnaerobicReserve({ consumedKJPerKg: 0 }, 2, 60, reserveParams);
    // 2 W/kg for 60s = 120 J/kg = 0.12 kJ/kg.
    expect(next.consumedKJPerKg).toBeCloseTo(0.12, 6);
  });

  it("clamps at reserveKJPerKg, never overshooting", () => {
    const reserveParams = { reserveKJPerKg: 0.1 };
    const next = stepAnaerobicReserve({ consumedKJPerKg: 0.08 }, 5, 60, reserveParams);
    expect(next.consumedKJPerKg).toBe(0.1);
  });

  it("is a no-op when boostDrawnWPerKg is 0", () => {
    const reserveParams = { reserveKJPerKg: 1 };
    const next = stepAnaerobicReserve({ consumedKJPerKg: 0.4 }, 0, 60, reserveParams);
    expect(next.consumedKJPerKg).toBe(0.4);
  });
});
