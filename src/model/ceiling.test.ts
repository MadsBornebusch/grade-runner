import { describe, expect, it } from "vitest";
import { altitudeFraction, anaerobicCapacityMultiplier, ceilingPower, sustainableFraction,
  forceExponentialCurve
} from "./ceiling";
import type { CeilingParams } from "./ceiling";

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

  it("returns a flat f0-at-LT2-cap fraction for any tMin when disabled, ignoring fInf/tau entirely", () => {
    const params = { pacingCurveEnabled: false, f0: 0.9, fInf: 0.3, tauMin: 100, lt2Fraction: 0.85 };
    for (const t of [0, 60, 600, 6000]) {
      expect(sustainableFraction(t, params)).toBeCloseTo(0.85, 6); // capped by lt2Fraction, not decaying toward fInf
    }
  });
});

describe("anaerobicCapacityMultiplier", () => {
  it("matches the critical-power anchor points at anaerobicCapacityMin=1", () => {
    expect(anaerobicCapacityMultiplier(4, 1)).toBeCloseTo(1.25, 2); // ~125% at 4 min
    expect(anaerobicCapacityMultiplier(8, 1)).toBeCloseTo(1.125, 2); // ~112% at 8 min
    expect(anaerobicCapacityMultiplier(15, 1)).toBeCloseTo(1.067, 2); // ~107% at 15 min
    expect(anaerobicCapacityMultiplier(30, 1)).toBeCloseTo(1.033, 2); // ~103% at 30 min
    expect(anaerobicCapacityMultiplier(55, 1)).toBeCloseTo(1.018, 2); // ~roughly LT2 by 55 min
  });

  it("is 1 (no boost) when disabled", () => {
    expect(anaerobicCapacityMultiplier(4, 0)).toBe(1);
  });

  it("is 1 for non-positive duration", () => {
    expect(anaerobicCapacityMultiplier(0, 1)).toBe(1);
    expect(anaerobicCapacityMultiplier(-5, 1)).toBe(1);
  });

  it("holds flat below the 2-minute floor instead of exploding toward t=0", () => {
    expect(anaerobicCapacityMultiplier(1, 1)).toBeCloseTo(1.5, 6);
    expect(anaerobicCapacityMultiplier(0.1, 1)).toBeCloseTo(1.5, 6);
  });

  it("asymptotes toward 1 (negligible) for long durations", () => {
    expect(anaerobicCapacityMultiplier(600, 1)).toBeLessThan(1.01);
  });

  it("scales linearly with anaerobicCapacityMin", () => {
    expect(anaerobicCapacityMultiplier(10, 2)).toBeCloseTo(1 + 2 * (anaerobicCapacityMultiplier(10, 1) - 1), 6);
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

  describe("pacingCurveEnabled", () => {
    it("disabling silences both the duration curve and both durability-drift terms at once", () => {
      const withEverything = ceilingPower(
        { tMin: 300, elapsedHours: 5, descentExposure: 500 },
        { durabilityDriftPerHour: 0.01, durabilityDriftPerDescentUnit: 0.0005 },
      );
      const curveOff = ceilingPower(
        { tMin: 300, elapsedHours: 5, descentExposure: 500 },
        { durabilityDriftPerHour: 0.01, durabilityDriftPerDescentUnit: 0.0005, pacingCurveEnabled: false },
      );
      const fresh = ceilingPower({ tMin: 0, elapsedHours: 0 }, { pacingCurveEnabled: false });
      expect(curveOff).toBeGreaterThan(withEverything);
      expect(curveOff).toBeCloseTo(fresh, 10); // flat regardless of how far into the event
    });
  });
});

describe("power-law duration curve", () => {
  const POWER_LAW: CeilingParams = {
    durationCurve: "powerLaw",
    powerLawFraction60Min: 0.813,
    powerLawExponent: 0.1602,
    lt2Fraction: 0.814,
  };

  it("is byte-for-byte unchanged when durationCurve is omitted (exponential default)", () => {
    const params: CeilingParams = { f0: 0.94, fInf: 0.66, tauMin: 220, lt2Fraction: 0.814 };
    for (const tMin of [10, 42, 92, 505, 1464]) {
      expect(sustainableFraction(tMin, { ...params, durationCurve: "exponential" })).toBe(
        sustainableFraction(tMin, params),
      );
    }
  });

  it("spans the real measured range the exponential could not", () => {
    // The measured failure this mode exists for: this athlete's actual
    // sustained fraction ran 86.1% (42min) down to 40.8% (24h24m), a factor
    // of 2.1, where the fitted exponential only spanned 83%->66% (1.26x).
    const short = sustainableFraction(42, POWER_LAW);
    const long = sustainableFraction(1464, POWER_LAW);
    expect(short / long).toBeGreaterThan(1.7);
  });

  it("reaches a 42-minute race the LT2 clamp sat below", () => {
    // Askerspurten: 86.1% actually sustained, against an 81.4% LT2 clamp --
    // the ceiling has to reach a race already run, which the clamp did not.
    // This race is one of the two hull points the envelope fit touches
    // exactly, so the bar here is "meets it", not "clears it by a margin";
    // the 3-4 digit rounding of the params above is why this is a
    // tolerance rather than a plain >=.
    expect(sustainableFraction(42, POWER_LAW)).toBeCloseTo(0.861, 3);
    expect(sustainableFraction(42, POWER_LAW)).toBeGreaterThan(0.814); // the old clamp
  });

  it("caps the aerobic term at VO2max instead of climbing past it on a short race", () => {
    // A raw power law crosses 100% around 16 minutes and keeps going.
    expect(sustainableFraction(10, POWER_LAW)).toBe(1);
    expect(sustainableFraction(1, POWER_LAW)).toBe(1);
    expect(sustainableFraction(0, POWER_LAW)).toBe(1);
  });

  it("is not clamped by lt2Fraction in power-law mode", () => {
    // The exponential mode's Math.min(fraction, lt2Fraction) is exactly what
    // held every sub-2h race to an identical ceiling; power-law mode must
    // not reintroduce it.
    expect(sustainableFraction(42, POWER_LAW)).toBeGreaterThan(POWER_LAW.lt2Fraction!);
  });

  it("lands on lt2Fraction at 60 minutes, the conventional LT2 anchor", () => {
    // Independent check, not a fitted constraint: LT2 is conventionally
    // ~60-minute power, and the envelope fit from race GPS data alone landed
    // within 0.1% of this athlete's lab-measured lt2Fraction.
    expect(sustainableFraction(60, POWER_LAW)).toBeCloseTo(0.813, 3);
  });

  it("decreases monotonically with duration past the VO2max cap", () => {
    const f = [20, 42, 92, 240, 505, 816, 1464, 2880].map((t) => sustainableFraction(t, POWER_LAW));
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeLessThan(f[i - 1]);
  });
});

describe("forceExponentialCurve", () => {
  it("strips power-law mode so pacingFit's exponential searches stay meaningful", () => {
    expect(forceExponentialCurve({ durationCurve: "powerLaw", fInf: 0.5 })).toEqual({
      durationCurve: "exponential",
      fInf: 0.5,
    });
  });

  it("leaves exponential params untouched", () => {
    const params: CeilingParams = { durationCurve: "exponential", fInf: 0.5 };
    expect(forceExponentialCurve(params)).toBe(params);
  });
});
