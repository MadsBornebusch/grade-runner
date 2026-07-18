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
  /** descentImpact.ts's descent-meters-times-speed metric, normalized per km
   * so races of different lengths are comparable -- the hypothesis being
   * tested alongside raw descentPerKm is that it's descent *covered fast*,
   * not descent alone, that drives eccentric-load fatigue. Speed is baked
   * directly into this metric, so it's confounded with avgIntensity the
   * same way a fast race is both "intense" and "high impact" -- the
   * meaningful comparison is against avgIntensity, not against
   * descentPerKm (impact will tend to beat raw descent for reasons that
   * have nothing to do with descent at all). */
  descentImpactPerKm: number;
  /** descentImpact.ts's speed^2-weighted variant, normalized per km --
   * kinetic-energy-proportional rather than linear-in-speed, offered as a
   * second, independent reading. Same confound caveat as
   * descentImpactPerKm: compare against avgIntensity, not descentPerKm. */
  descentImpactSquaredPerKm: number;
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
  descentImpactCorrelation: number | null;
  descentImpactSquaredCorrelation: number | null;
}

/** Exported for reuse by withinRaceDescentDiagnostic.ts's own correlations. */
export const MIN_POINTS_FOR_CORRELATION = 3;

export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
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
    descentImpactCorrelation: pearsonCorrelation(
      tauValues,
      points.map((p) => p.descentImpactPerKm),
    ),
    descentImpactSquaredCorrelation: pearsonCorrelation(
      tauValues,
      points.map((p) => p.descentImpactSquaredPerKm),
    ),
  };
}
