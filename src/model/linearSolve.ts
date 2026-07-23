// Minimal dense linear-algebra primitives for jointSlowdownFit.ts's
// multi-variable weighted least squares -- this project has no linear-
// algebra dependency, and the design matrices here are small (a handful of
// slowdown-factor columns), so plain Gauss-Jordan elimination is simpler
// than adding one.

/**
 * Solves A*x = b via Gauss-Jordan elimination with partial pivoting.
 * Returns null if A is singular (or numerically indistinguishable from
 * singular) rather than throwing -- callers should treat that as "this
 * combination of regressors can't be jointly fit" (severe collinearity),
 * not a bug.
 */
export function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(m[pivotRow][col]) < 1e-9) return null;
    [m[col], m[pivotRow]] = [m[pivotRow], m[col]];
    const pivotVal = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= pivotVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

export interface WeightedLeastSquaresResult {
  coefficients: number[];
  /** Weighted R^2 -- 1 - (weighted SS residual / weighted SS total). Callers
   * whose X/y are already within-group demeaned (jointSlowdownFit.ts's own
   * run-fixed-effects design) should read this as a within-run R^2, not an
   * overall one. */
  rSquared: number;
}

/**
 * Multi-variable weighted least squares: minimizes sum_i w_i*(y_i - x_i.beta)^2
 * via the normal equations (X'WX)*beta = X'Wy. No intercept column is added
 * automatically -- callers that need one must include a constant column
 * themselves (jointSlowdownFit.ts's within-run-demeaned design doesn't need
 * one; demeaning already removes each group's own constant).
 */
export function weightedLeastSquares(x: number[][], y: number[], w: number[]): WeightedLeastSquaresResult | null {
  const n = x.length;
  const k = x[0]?.length ?? 0;
  if (n === 0 || k === 0) return null;

  const xtwx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xtwy: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xtwy[a] += w[i] * x[i][a] * y[i];
      for (let b = 0; b < k; b++) {
        xtwx[a][b] += w[i] * x[i][a] * x[i][b];
      }
    }
  }

  const coefficients = solveLinearSystem(xtwx, xtwy);
  if (!coefficients) return null;

  let sumW = 0;
  let sumWY = 0;
  for (let i = 0; i < n; i++) {
    sumW += w[i];
    sumWY += w[i] * y[i];
  }
  if (sumW <= 0) return null;
  const meanY = sumWY / sumW;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = x[i].reduce((sum, xij, j) => sum + xij * coefficients[j], 0);
    ssRes += w[i] * (y[i] - predicted) ** 2;
    ssTot += w[i] * (y[i] - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { coefficients, rSquared };
}

/**
 * Variance Inflation Factor per column: regresses each column on all the
 * OTHER columns and reports 1/(1-R^2) of that regression -- the standard
 * collinearity diagnostic (VIF >= ~5-10 is the usual rule-of-thumb concern
 * threshold). A column with only itself (k=1) trivially gets VIF=1: there's
 * nothing else to be collinear with. Returns Infinity for a column that's
 * an exact (or near-exact) linear combination of the others -- callers
 * should treat that as "these regressors can't be separated," not a
 * software bug.
 */
export function varianceInflationFactors(x: number[][], w: number[]): number[] {
  const k = x[0]?.length ?? 0;
  const vifs: number[] = [];
  for (let j = 0; j < k; j++) {
    const others = x.map((row) => row.filter((_, idx) => idx !== j));
    const target = x.map((row) => row[j]);
    const fit = weightedLeastSquares(others, target, w);
    const rSquared = fit?.rSquared ?? 0;
    vifs.push(rSquared >= 0.999999 ? Infinity : 1 / (1 - rSquared));
  }
  return vifs;
}
