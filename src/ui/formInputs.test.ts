import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FORM_INPUTS,
  loadFormInputs,
  equivalentLT1LT2,
  resolveSubstrateAnchors,
  resolveVo2Max,
  speedFromMs,
  speedToMs,
  substrateAnchorsFromThresholds,
  suggestedFoPeakGPerMin,
  type Vo2MaxEntry,
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

function singleVo2MaxEntry(value: number): Vo2MaxEntry[] {
  return [{ date: "2024-01-01", value, source: "manual" }];
}

describe("equivalentLT1LT2", () => {
  const base = { lt1Fraction: 0.65, lt2Fraction: 0.85, walkMaxMs: 2.0, vo2MaxHistory: singleVo2MaxEntry(50) };
  const fatOxPoints = [
    { paceMinPerKm: 7, fatGPerMin: 0.5, carbGPerMin: 0.8 },
    { paceMinPerKm: 5, fatGPerMin: 0.3, carbGPerMin: 1.8 },
    { paceMinPerKm: 4, fatGPerMin: 0.1, carbGPerMin: 3.0 },
  ];

  it("returns null with no fat-ox points (nothing to derive)", () => {
    expect(equivalentLT1LT2({ ...base, fatOxPoints: [] })).toBeNull();
  });

  it("derives an equivalent LT1 below LT2, in a plausible %VO2max range", () => {
    const result = equivalentLT1LT2({ ...base, fatOxPoints });
    expect(result).not.toBeNull();
    expect(result!.lt1Fraction).toBeLessThan(result!.lt2Fraction);
    expect(result!.lt1Fraction).toBeGreaterThan(0.2);
    expect(result!.lt2Fraction).toBeLessThan(1.5);
  });

  it("scales inversely with resolved VO2max -- the same curve implies a lower %VO2max the higher VO2max is", () => {
    const lowerVo2 = equivalentLT1LT2({ ...base, fatOxPoints, vo2MaxHistory: singleVo2MaxEntry(45) })!;
    const higherVo2 = equivalentLT1LT2({ ...base, fatOxPoints, vo2MaxHistory: singleVo2MaxEntry(60) })!;
    expect(higherVo2.lt1Fraction).toBeLessThan(lowerVo2.lt1Fraction);
  });
});

describe("resolveVo2Max", () => {
  it("returns undefined for empty history", () => {
    expect(resolveVo2Max([])).toBeUndefined();
  });

  it("returns the single entry's value when there's only one", () => {
    expect(resolveVo2Max(singleVo2MaxEntry(55))).toBeCloseTo(55, 6);
  });

  it("weights a lab entry far more than a manual entry of the same age", () => {
    const now = new Date("2025-01-01");
    const labHigher = resolveVo2Max(
      [
        { date: "2024-12-01", value: 60, source: "lab" },
        { date: "2024-12-01", value: 40, source: "manual" },
      ],
      now,
    )!;
    // Should land much closer to the lab value (60) than a plain average (50).
    expect(labHigher).toBeGreaterThan(55);
  });

  it("weights a recent entry more than an old one of the same source", () => {
    const now = new Date("2025-01-01");
    const result = resolveVo2Max(
      [
        { date: "2024-12-25", value: 60, source: "manual" }, // 7 days ago
        { date: "2020-01-01", value: 40, source: "manual" }, // ~5 years ago
      ],
      now,
    )!;
    // The ancient entry should be almost entirely discounted.
    expect(result).toBeGreaterThan(58);
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

describe("aerobic ceiling", () => {
  const KEY = "grade-runner:inputs";
  // The suite runs in node, which has no localStorage. A minimal in-memory
  // stand-in is enough: loadFormInputs only ever does getItem here.
  beforeAll(() => {
    if (typeof globalThis.localStorage !== "undefined") return;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      },
    });
  });

  const withSaved = <T,>(saved: Record<string, unknown> | null, fn: () => T): T => {
    const before = localStorage.getItem(KEY);
    try {
      if (saved === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(saved));
      return fn();
    } finally {
      if (before === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, before);
    }
  };

  it("carries an unfitted athlete on a plausible default curve", () => {
    // With fewer than 3 confirmed races nothing is fitted, so these anchors
    // are what every new athlete actually predicts through. There is no
    // second curve to fall back to any more, which is the point: the one
    // that used to fill that role asserted an athlete could hold 38% of
    // VO2max forever.
    expect(DEFAULT_FORM_INPUTS.powerLawFraction60Min).toBeGreaterThan(0.6);
    expect(DEFAULT_FORM_INPUTS.powerLawFraction60Min).toBeLessThan(0.95);
    expect(DEFAULT_FORM_INPUTS.powerLawExponent).toBeGreaterThan(0.05);
    expect(DEFAULT_FORM_INPUTS.powerLawExponent).toBeLessThan(0.3);
  });

  it("loads a profile saved under the retired exponential curve without choking", () => {
    // Those keys are simply no longer read. An old save must still produce a
    // working profile rather than throwing or resetting everything.
    const loaded = withSaved(
      { durationCurve: "exponential", f0: 0.94, fInf: 0.38, tauMin: 250, bodyMassKg: 72 },
      loadFormInputs,
    );
    expect(loaded.bodyMassKg).toBe(72);
    expect(loaded.powerLawFraction60Min).toBe(DEFAULT_FORM_INPUTS.powerLawFraction60Min);
  });

  it("keeps a saved profile's own fitted anchors rather than resetting them", () => {
    const kept = withSaved({ powerLawFraction60Min: 0.77, powerLawExponent: 0.19 }, loadFormInputs);
    expect(kept.powerLawFraction60Min).toBeCloseTo(0.77, 6);
    expect(kept.powerLawExponent).toBeCloseTo(0.19, 6);
  });
});
