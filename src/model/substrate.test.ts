import { describe, expect, it } from "vitest";
import {
  bonkPowerWPerKg,
  carbEnergyFraction,
  fatOxPacePointToPowerFraction,
  fatOxPointToFraction,
  fitCarbFractionAnchors,
  splitPower,
  stepGlycogen,
} from "./substrate";

describe("carbEnergyFraction", () => {
  it("is 0.5 at LT1 and ~0.9 at LT2 with defaults", () => {
    expect(carbEnergyFraction(0.65)).toBeCloseTo(0.5, 6);
    expect(carbEnergyFraction(0.85)).toBeCloseTo(0.9, 2);
  });

  it("increases monotonically with intensity", () => {
    const xs = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const ys = xs.map((x) => carbEnergyFraction(x));
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
  });
});

describe("fitCarbFractionAnchors", () => {
  it("recovers known (x0, k) from noise-free synthetic data", () => {
    const trueX0 = 0.6;
    const trueK = 12;
    const points = [0.5, 0.6, 0.7, 0.8].map((x) => ({
      x,
      fC: 1 / (1 + Math.exp(-trueK * (x - trueX0))),
    }));
    const { x0, k } = fitCarbFractionAnchors(points);
    expect(x0).toBeCloseTo(trueX0, 4);
    expect(k).toBeCloseTo(trueK, 4);
  });

  it("shifts only x0 (keeping default k) for a single point", () => {
    const { x0, k } = fitCarbFractionAnchors([{ x: 0.7, fC: 0.5 }], 11);
    expect(k).toBe(11);
    expect(x0).toBeCloseTo(0.7, 6);
  });

  it("stays finite when a point sits exactly at the fC=0 or fC=1 boundary", () => {
    const points = [
      { x: 5, fC: 0 },
      { x: 10, fC: 0.5 },
      { x: 15, fC: 1 },
    ];
    const { x0, k } = fitCarbFractionAnchors(points);
    expect(Number.isFinite(x0)).toBe(true);
    expect(Number.isFinite(k)).toBe(true);
  });
});

describe("fatOxPointToFraction", () => {
  it("produces a fraction in (0,1) for a plausible data point", () => {
    // 70kg athlete, 0.6 g/min fat at a gross power of ~8 W/kg
    const { x, fC } = fatOxPointToFraction(0.6, 0.6, 8, 70);
    expect(x).toBe(0.6);
    expect(fC).toBeGreaterThan(0);
    expect(fC).toBeLessThan(1);
  });
});

describe("fatOxPacePointToPowerFraction", () => {
  it("returns x in absolute gross-power units, not a %VO2max fraction", () => {
    // 5:00/km = 3.33 m/s, well above the walk threshold -> running cost.
    const { x } = fatOxPacePointToPowerFraction(5, 0.5, 1.5);
    expect(x).toBeGreaterThan(5); // gross power at running pace is several W/kg
    expect(x).toBeLessThan(20);
  });

  it("produces a fraction in (0,1) for a plausible point", () => {
    const { fC } = fatOxPacePointToPowerFraction(6, 0.4, 1.5);
    expect(fC).toBeGreaterThan(0);
    expect(fC).toBeLessThan(1);
  });

  it("uses the walking cost curve below the walk-speed threshold", () => {
    // ~10:00/km = 1.67 m/s, below the default 2.0 m/s walk threshold.
    const { x: walkX } = fatOxPacePointToPowerFraction(10, 0.3, 1.0);
    const { x: runX } = fatOxPacePointToPowerFraction(5, 0.3, 1.0);
    expect(walkX).toBeLessThan(runX);
  });

  it("computes fC as a pure ratio of measured rates, independent of Minetti's assumed power", () => {
    // At an easy pace with high measured fat oxidation, the old formula (which
    // compared measured fat against Minetti's *assumed* gross power for that
    // pace) could go negative or even land above 1 if the two disagreed. The
    // ratio-based formula can't: it's bounded in (0,1) by construction for any
    // positive fat/carb rates.
    const { fC } = fatOxPacePointToPowerFraction(10, 0.6, 0.3);
    expect(fC).toBeGreaterThan(0);
    expect(fC).toBeLessThan(1);
  });

  it("stays finite when fat oxidation is exactly zero (max-effort test stage)", () => {
    const { fC } = fatOxPacePointToPowerFraction(4, 0, 3.0);
    expect(fC).toBe(1);
    expect(Number.isFinite(fC)).toBe(true);
  });
});

describe("splitPower", () => {
  it("conserves energy: carb + fat rate always equals gross power", () => {
    for (const x of [0.3, 0.5, 0.65, 0.8, 0.95, 1.1]) {
      for (const pGross of [4, 8, 12, 20]) {
        const { carbRateWPerKg, fatRateWPerKg } = splitPower(pGross, x, 70);
        expect(carbRateWPerKg + fatRateWPerKg).toBeCloseTo(pGross, 8);
      }
    }
  });

  it("caps fat rate at the FO_peak ceiling and forces the shortfall onto carbs", () => {
    // Low intensity => high uncapped fat fraction, but ceiling still applies.
    const { fatRateWPerKg, fatCapped } = splitPower(20, 0.1, 70);
    expect(fatCapped).toBe(true);
    const expectedCeiling = ((0.55 / 60) * 37.7 * 1000) / 70;
    expect(fatRateWPerKg).toBeCloseTo(expectedCeiling, 6);
  });

  it("does not cap fat rate at high intensity where carb dominates", () => {
    const { fatCapped } = splitPower(15, 1.0, 70);
    expect(fatCapped).toBe(false);
  });
});

describe("stepGlycogen", () => {
  it("depletes glycogen when demand exceeds exogenous supply", () => {
    const state = { glycogenG: 400 };
    const next = stepGlycogen(state, 6, 70, { intakeGPerH: 60, gutMaxGPerH: 60 }, 60);
    expect(next.glycogenG).toBeLessThan(state.glycogenG);
  });

  it("never drops below the reserve floor", () => {
    const state = { glycogenG: 61 };
    const next = stepGlycogen(
      state,
      20,
      70,
      { intakeGPerH: 0, gutMaxGPerH: 60 },
      3600, // a full hour of huge deficit
      60,
    );
    expect(next.glycogenG).toBeGreaterThanOrEqual(60);
  });

  it("replenishes when exogenous supply exceeds demand", () => {
    const state = { glycogenG: 300 };
    const next = stepGlycogen(state, 1, 70, { intakeGPerH: 60, gutMaxGPerH: 60 }, 60);
    expect(next.glycogenG).toBeGreaterThan(state.glycogenG);
  });
});

describe("bonkPowerWPerKg", () => {
  it("is positive and combines fat ceiling with gut-limited exogenous carb", () => {
    const power = bonkPowerWPerKg(70, { intakeGPerH: 90, gutMaxGPerH: 60 });
    expect(power).toBeGreaterThan(0);
    // gut caps exogenous carb at 60 g/h even though intake is 90
    const withHigherIntake = bonkPowerWPerKg(70, { intakeGPerH: 200, gutMaxGPerH: 60 });
    expect(withHigherIntake).toBeCloseTo(power, 10);
  });
});
