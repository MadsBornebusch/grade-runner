import { describe, expect, it } from "vitest";
import { solveLinearSystem, varianceInflationFactors, weightedLeastSquares } from "./linearSolve";

describe("solveLinearSystem", () => {
  it("solves a simple 2x2 system exactly", () => {
    // 2x + y = 5, x - y = 1 -> x=2, y=1
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, -1],
      ],
      [5, 1],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2, 8);
    expect(x![1]).toBeCloseTo(1, 8);
  });

  it("returns null for a singular matrix", () => {
    const x = solveLinearSystem(
      [
        [1, 2],
        [2, 4],
      ],
      [1, 2],
    );
    expect(x).toBeNull();
  });

  it("handles a 3x3 system requiring pivoting", () => {
    const x = solveLinearSystem(
      [
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 0],
      ],
      [3, 3, 2],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1, 8);
    expect(x![1]).toBeCloseTo(1, 8);
    expect(x![2]).toBeCloseTo(2, 8);
  });
});

describe("weightedLeastSquares", () => {
  it("recovers exact coefficients on noiseless data, unweighted", () => {
    // y = 2*x0 - 3*x1
    const x = [
      [1, 0],
      [0, 1],
      [2, 1],
      [1, 2],
    ];
    const y = x.map(([a, b]) => 2 * a - 3 * b);
    const w = x.map(() => 1);
    const fit = weightedLeastSquares(x, y, w);
    expect(fit).not.toBeNull();
    expect(fit!.coefficients[0]).toBeCloseTo(2, 6);
    expect(fit!.coefficients[1]).toBeCloseTo(-3, 6);
    expect(fit!.rSquared).toBeCloseTo(1, 6);
  });

  it("gives near-zero weight observations no influence on the fit", () => {
    const x = [
      [1],
      [2],
      [3],
      [100], // an outlier that would badly bias an unweighted fit
    ];
    const y = [2, 4, 6, 5]; // true slope 2, last point wildly off
    const w = [1, 1, 1, 1e-9];
    const fit = weightedLeastSquares(x, y, w);
    expect(fit).not.toBeNull();
    expect(fit!.coefficients[0]).toBeCloseTo(2, 2);
  });

  it("returns null for empty input", () => {
    expect(weightedLeastSquares([], [], [])).toBeNull();
  });

  it("returns a low R^2 on pure noise-dominated data relative to a clean fit", () => {
    const x = [[1], [2], [3], [4], [5]];
    const yClean = x.map(([a]) => 2 * a);
    const yNoisy = [1, 8, 0, 15, -3]; // unrelated to x
    const cleanFit = weightedLeastSquares(x, yClean, [1, 1, 1, 1, 1]);
    const noisyFit = weightedLeastSquares(x, yNoisy, [1, 1, 1, 1, 1]);
    expect(cleanFit!.rSquared).toBeGreaterThan(noisyFit!.rSquared);
  });
});

describe("varianceInflationFactors", () => {
  it("reports VIF near 1 for uncorrelated regressors", () => {
    const x = [
      [1, 5],
      [2, 1],
      [3, 4],
      [4, 2],
      [5, 3],
    ];
    const w = x.map(() => 1);
    const vifs = varianceInflationFactors(x, w);
    expect(vifs).toHaveLength(2);
    for (const v of vifs) expect(v).toBeLessThan(2);
  });

  it("reports a high VIF when two regressors are near-collinear", () => {
    const x = [
      [1, 1.01],
      [2, 2.02],
      [3, 2.99],
      [4, 4.01],
      [5, 5.02],
    ];
    const w = x.map(() => 1);
    const vifs = varianceInflationFactors(x, w);
    expect(vifs[0]).toBeGreaterThan(10);
    expect(vifs[1]).toBeGreaterThan(10);
  });

  it("reports VIF exactly 1 for a single-column design (nothing else to compete with)", () => {
    const x = [[1], [2], [3]];
    const vifs = varianceInflationFactors(x, [1, 1, 1]);
    expect(vifs[0]).toBeCloseTo(1, 6);
  });

  it("reports Infinity for an exactly collinear pair", () => {
    const x = [
      [1, 2],
      [2, 4],
      [3, 6],
      [4, 8],
    ];
    const vifs = varianceInflationFactors(x, [1, 1, 1, 1]);
    expect(vifs[0]).toBe(Infinity);
    expect(vifs[1]).toBe(Infinity);
  });
});
