import { describe, expect, it } from "vitest";
import { resolveSubstrateAnchors, substrateAnchorsFromThresholds } from "./formInputs";

describe("substrateAnchorsFromThresholds", () => {
  it("matches substrate.ts's own defaults at LT1=0.65/LT2=0.85", () => {
    const { x0, k } = substrateAnchorsFromThresholds(0.65, 0.85);
    expect(x0).toBeCloseTo(0.65, 6);
    expect(k).toBeCloseTo(11.0, 1);
  });
});

describe("resolveSubstrateAnchors", () => {
  const base = { lt1Fraction: 0.65, lt2Fraction: 0.85, walkMaxMs: 2.0 };

  it("falls back to LT1/LT2 (%VO2max mode) with no fat-ox points", () => {
    const result = resolveSubstrateAnchors({ ...base, fatOxPoints: [] });
    expect(result.intensityIsAbsolutePower).toBe(false);
    expect(result.x0).toBeCloseTo(0.65, 6);
  });

  it("fits directly in absolute power from fat-ox points, ignoring LT1/LT2", () => {
    const result = resolveSubstrateAnchors({
      ...base,
      fatOxPoints: [
        { paceMinPerKm: 7, fatGPerMin: 0.5, carbGPerMin: 0.8 },
        { paceMinPerKm: 5, fatGPerMin: 0.3, carbGPerMin: 1.8 },
        { paceMinPerKm: 4, fatGPerMin: 0.1, carbGPerMin: 3.0 },
      ],
    });
    expect(result.intensityIsAbsolutePower).toBe(true);
    // x0 should land in a plausible gross-power range (W/kg), not a 0-1 fraction.
    expect(result.x0).toBeGreaterThan(1);
    expect(result.x0).toBeLessThan(20);
  });

  it("handles a single fat-ox point via the fallback slope", () => {
    const result = resolveSubstrateAnchors({
      ...base,
      fatOxPoints: [{ paceMinPerKm: 6, fatGPerMin: 0.4, carbGPerMin: 1.2 }],
    });
    expect(result.intensityIsAbsolutePower).toBe(true);
    expect(Number.isFinite(result.x0)).toBe(true);
    expect(Number.isFinite(result.k)).toBe(true);
  });

  it("stays finite even when a point has zero fat oxidation (max-effort test stage)", () => {
    const result = resolveSubstrateAnchors({
      ...base,
      fatOxPoints: [
        { paceMinPerKm: 10, fatGPerMin: 0.6, carbGPerMin: 0.5 },
        { paceMinPerKm: 6, fatGPerMin: 0.2, carbGPerMin: 2.0 },
        { paceMinPerKm: 4, fatGPerMin: 0, carbGPerMin: 4.0 },
      ],
    });
    expect(Number.isFinite(result.x0)).toBe(true);
    expect(Number.isFinite(result.k)).toBe(true);
  });
});
