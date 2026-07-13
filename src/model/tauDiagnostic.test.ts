import { describe, expect, it } from "vitest";
import { computeTauDiagnostic, type RaceDiagnosticPoint } from "./tauDiagnostic";

function point(overrides: Partial<RaceDiagnosticPoint>): RaceDiagnosticPoint {
  return {
    label: "race",
    tauMin: 200,
    avgIntensity: 0.7,
    descentPerKm: 20,
    descentImpactPerKm: 15,
    descentImpactSquaredPerKm: 30,
    ...overrides,
  };
}

describe("computeTauDiagnostic", () => {
  it("returns null correlations with fewer than 3 points", () => {
    const result = computeTauDiagnostic([point({}), point({})]);
    expect(result.intensityCorrelation).toBeNull();
    expect(result.descentCorrelation).toBeNull();
    expect(result.descentImpactCorrelation).toBeNull();
    expect(result.descentImpactSquaredCorrelation).toBeNull();
  });

  it("finds a strong negative correlation when higher intensity means a smaller tau", () => {
    const points = [
      point({ label: "a", tauMin: 600, avgIntensity: 0.5, descentPerKm: 10 }),
      point({ label: "b", tauMin: 400, avgIntensity: 0.65, descentPerKm: 10 }),
      point({ label: "c", tauMin: 200, avgIntensity: 0.8, descentPerKm: 10 }),
      point({ label: "d", tauMin: 100, avgIntensity: 0.9, descentPerKm: 10 }),
    ];
    const result = computeTauDiagnostic(points);
    expect(result.intensityCorrelation).not.toBeNull();
    expect(result.intensityCorrelation!).toBeLessThan(-0.9);
  });

  it("finds a strong negative correlation when more descent means a smaller tau, independent of intensity", () => {
    const points = [
      point({ label: "a", tauMin: 600, avgIntensity: 0.7, descentPerKm: 5 }),
      point({ label: "b", tauMin: 400, avgIntensity: 0.7, descentPerKm: 20 }),
      point({ label: "c", tauMin: 200, avgIntensity: 0.7, descentPerKm: 40 }),
      point({ label: "d", tauMin: 100, avgIntensity: 0.7, descentPerKm: 60 }),
    ];
    const result = computeTauDiagnostic(points);
    expect(result.descentCorrelation).not.toBeNull();
    expect(result.descentCorrelation!).toBeLessThan(-0.9);
    // Intensity was held constant here -- no variance, so no correlation to report.
    expect(result.intensityCorrelation).toBeNull();
  });

  it("finds a strong negative correlation when more descent impact means a smaller tau, independent of raw descent", () => {
    const points = [
      point({ label: "a", tauMin: 600, descentPerKm: 30, descentImpactPerKm: 5 }),
      point({ label: "b", tauMin: 400, descentPerKm: 30, descentImpactPerKm: 20 }),
      point({ label: "c", tauMin: 200, descentPerKm: 30, descentImpactPerKm: 40 }),
      point({ label: "d", tauMin: 100, descentPerKm: 30, descentImpactPerKm: 60 }),
    ];
    const result = computeTauDiagnostic(points);
    expect(result.descentImpactCorrelation).not.toBeNull();
    expect(result.descentImpactCorrelation!).toBeLessThan(-0.9);
    // Raw descent was held constant -- no variance, so no correlation to report.
    expect(result.descentCorrelation).toBeNull();
  });

  it("finds a strong negative correlation when more speed-squared descent impact means a smaller tau", () => {
    const points = [
      point({ label: "a", tauMin: 600, descentPerKm: 30, descentImpactPerKm: 15, descentImpactSquaredPerKm: 5 }),
      point({ label: "b", tauMin: 400, descentPerKm: 30, descentImpactPerKm: 15, descentImpactSquaredPerKm: 20 }),
      point({ label: "c", tauMin: 200, descentPerKm: 30, descentImpactPerKm: 15, descentImpactSquaredPerKm: 40 }),
      point({ label: "d", tauMin: 100, descentPerKm: 30, descentImpactPerKm: 15, descentImpactSquaredPerKm: 60 }),
    ];
    const result = computeTauDiagnostic(points);
    expect(result.descentImpactSquaredCorrelation).not.toBeNull();
    expect(result.descentImpactSquaredCorrelation!).toBeLessThan(-0.9);
    // Both raw descent and linear descent impact were held constant --
    // no variance, so no correlation to report for either.
    expect(result.descentCorrelation).toBeNull();
    expect(result.descentImpactCorrelation).toBeNull();
  });

  it("returns a correlation near zero when tau doesn't track the signal at all", () => {
    // By construction: intensity deviations are odd-symmetric, tau deviations
    // are even-symmetric around the same 5 points, so their covariance is
    // exactly zero -- not just "small sample, might not be zero."
    const points = [
      point({ label: "a", tauMin: 320, avgIntensity: 0.5 }),
      point({ label: "b", tauMin: 280, avgIntensity: 0.6 }),
      point({ label: "c", tauMin: 300, avgIntensity: 0.7 }),
      point({ label: "d", tauMin: 280, avgIntensity: 0.8 }),
      point({ label: "e", tauMin: 320, avgIntensity: 0.9 }),
    ];
    const result = computeTauDiagnostic(points);
    expect(result.intensityCorrelation!).toBeCloseTo(0, 6);
  });
});
