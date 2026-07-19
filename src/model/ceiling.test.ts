import { describe, expect, it } from "vitest";
import { altitudeFraction, ceilingPower, sustainableFraction } from "./ceiling";

describe("sustainableFraction", () => {
  it("starts near f0 and decays toward f_inf, capped by LT2", () => {
    expect(sustainableFraction(0)).toBeCloseTo(0.85, 6); // f0=0.94 capped to lt2=0.85
    const long = sustainableFraction(24 * 60);
    expect(long).toBeGreaterThan(0.38);
    expect(long).toBeLessThan(0.5);
  });

  it("never exceeds LT2", () => {
    for (const t of [0, 1, 10, 100, 1000]) {
      expect(sustainableFraction(t, { lt2Fraction: 0.85 })).toBeLessThanOrEqual(0.85);
    }
  });

  it("stays positive for 24h+ (replaces the Saltin fraction that goes negative)", () => {
    for (const hours of [1, 5, 10, 15.6, 24, 48]) {
      expect(sustainableFraction(hours * 60)).toBeGreaterThan(0);
    }
  });

  it("respects a custom LT2 cap", () => {
    expect(sustainableFraction(0, { lt2Fraction: 0.7 })).toBeCloseTo(0.7, 6);
  });
});

describe("altitudeFraction", () => {
  it("is 1.0 at sea level", () => {
    expect(altitudeFraction(0)).toBeCloseTo(1, 6);
  });

  it("matches the PLAN reference points", () => {
    expect(altitudeFraction(2000)).toBeCloseTo(0.94, 1);
    expect(altitudeFraction(4000)).toBeCloseTo(0.8, 1);
  });
});

describe("ceilingPower", () => {
  it("is positive and decreases with altitude", () => {
    const sea = ceilingPower({ tMin: 60, altitudeM: 0 });
    const alt = ceilingPower({ tMin: 60, altitudeM: 3000 });
    expect(sea).toBeGreaterThan(0);
    expect(alt).toBeLessThan(sea);
  });

  it("durability drift reduces the ceiling over elapsed hours when enabled", () => {
    const noDrift = ceilingPower({ tMin: 300, elapsedHours: 5 });
    const withDrift = ceilingPower(
      { tMin: 300, elapsedHours: 5 },
      { durabilityDriftPerHour: 0.01 },
    );
    expect(withDrift).toBeLessThan(noDrift);
  });

  it("durability drift is off by default (no effect at elapsedHours=0)", () => {
    const a = ceilingPower({ tMin: 0, elapsedHours: 0 });
    const b = ceilingPower({ tMin: 0, elapsedHours: 0 }, { durabilityDriftPerHour: 0.02 });
    expect(a).toBeCloseTo(b, 10);
  });

  describe("descent-based durability drift (PLAN.md §12/§13 stage 5)", () => {
    it("reduces the ceiling over cumulative descent exposure when enabled", () => {
      const noDrift = ceilingPower({ tMin: 300, descentExposure: 500 });
      const withDrift = ceilingPower({ tMin: 300, descentExposure: 500 }, { durabilityDriftPerDescentUnit: 0.0005 });
      expect(withDrift).toBeLessThan(noDrift);
    });

    it("is off by default, and has no effect even when descentExposure is provided", () => {
      const a = ceilingPower({ tMin: 300, descentExposure: 1000 });
      const b = ceilingPower({ tMin: 300, descentExposure: 1000 }, {});
      expect(a).toBeCloseTo(b, 10);
    });

    it("has no effect when descentExposure is omitted, even if the rate is configured", () => {
      // A caller that never tracked descent exposure shouldn't be silently
      // penalized just because a rate happens to be configured -- the term
      // needs an explicit exposure value to apply at all.
      const a = ceilingPower({ tMin: 300 });
      const b = ceilingPower({ tMin: 300 }, { durabilityDriftPerDescentUnit: 0.0005 });
      expect(a).toBeCloseTo(b, 10);
    });

    it("doesn't affect the elapsed-time-based drift term, and both compose when both are set", () => {
      const timeOnly = ceilingPower({ tMin: 300, elapsedHours: 5 }, { durabilityDriftPerHour: 0.01 });
      const both = ceilingPower(
        { tMin: 300, elapsedHours: 5, descentExposure: 500 },
        { durabilityDriftPerHour: 0.01, durabilityDriftPerDescentUnit: 0.0005 },
      );
      // Both terms active should reduce the ceiling further than either alone.
      expect(both).toBeLessThan(timeOnly);
    });
  });
});
