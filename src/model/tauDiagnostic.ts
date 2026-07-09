// PLAN.md §12 stage 4 / §13: a cheap diagnostic testing whether descent
// load (or generic intensity) actually predicts this athlete's own
// single-race tau, before committing to the stage-5 model redesign.
// Correlation only, no fitting -- just enough to tell whether there's a
// real signal in this athlete's own library worth building further on.

export interface RaceDiagnosticPoint {
  label: string;
  tauMin: number;
  avgIntensity: number;
  descentPerKm: number;
}

export interface TauDiagnosticResult {
  points: RaceDiagnosticPoint[];
  /**
   * Pearson r between tau and each signal. The stage-5 hypothesis (harder/
   * more eccentric-loaded efforts fade faster) predicts a *negative*
   * correlation -- higher intensity or descent load going with a *smaller*
   * tau (faster decay) -- not just "any" correlation.
   */
  intensityCorrelation: number | null;
  descentCorrelation: number | null;
}

const MIN_POINTS_FOR_CORRELATION = 3;

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < MIN_POINTS_FOR_CORRELATION) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

export function computeTauDiagnostic(points: RaceDiagnosticPoint[]): TauDiagnosticResult {
  const tauValues = points.map((p) => p.tauMin);
  return {
    points,
    intensityCorrelation: pearsonCorrelation(
      tauValues,
      points.map((p) => p.avgIntensity),
    ),
    descentCorrelation: pearsonCorrelation(
      tauValues,
      points.map((p) => p.descentPerKm),
    ),
  };
}
