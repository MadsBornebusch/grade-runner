import { describe, expect, it } from "vitest";
import {
  resolveSubstrateAnchors,
  speedFromMs,
  speedToMs,
  substrateAnchorsFromThresholds,
  suggestedFoPeakGPerMin,
} from "./formInputs";

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

describe("suggestedFoPeakGPerMin", () => {
  it("returns null with no points", () => {
    expect(suggestedFoPeakGPerMin([])).toBeNull();
  });

  it("returns the highest measured fat-oxidation rate", () => {
    const points = [
      { paceMinPerKm: 7, fatGPerMin: 0.5, carbGPerMin: 0.8 },
      { paceMinPerKm: 10, fatGPerMin: 0.7, carbGPerMin: 0.3 },
      { paceMinPerKm: 4, fatGPerMin: 0, carbGPerMin: 4.0 },
    ];
    expect(suggestedFoPeakGPerMin(points)).toBe(0.7);
  });
});

describe("speedFromMs / speedToMs", () => {
  it("round-trips through km/h", () => {
    const ms = 2.0;
    const kmh = speedFromMs(ms, "kmh");
    expect(kmh).toBeCloseTo(7.2, 6);
    expect(speedToMs(kmh, "kmh")).toBeCloseTo(ms, 6);
  });

  it("round-trips through min/km", () => {
    const ms = 2.0;
    const pace = speedFromMs(ms, "minkm");
    expect(pace).toBeCloseTo(8.333, 2);
    expect(speedToMs(pace, "minkm")).toBeCloseTo(ms, 6);
  });

  it("is identity for m/s", () => {
    expect(speedFromMs(2.0, "ms")).toBe(2.0);
    expect(speedToMs(2.0, "ms")).toBe(2.0);
  });
});
