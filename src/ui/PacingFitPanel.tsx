import { useState } from "react";
import type { CeilingParams } from "../model/ceiling";
import { fitDurabilityDriftPerHour, fitTauMinutes, type EffortTrendPoint } from "../model/pacingFit";

interface PacingFitPanelProps {
  points: EffortTrendPoint[];
  ceilingParams: CeilingParams;
  onApplyTau: (tauMin: number) => void;
  onApplyDrift: (driftPerHour: number) => void;
}

// A residual trend below this is "flat enough" -- not worth chasing further
// or flagging as a mismatch.
const FLAT_ENOUGH_PCT_PER_HOUR = 3;

export function PacingFitPanel({ points, ceilingParams, onApplyTau, onApplyDrift }: PacingFitPanelProps) {
  const [result, setResult] = useState<{
    tau: ReturnType<typeof fitTauMinutes>;
    drift: ReturnType<typeof fitDurabilityDriftPerHour> | null;
  } | null>(null);
  const [ran, setRan] = useState(false);

  const run = () => {
    const tau = fitTauMinutes(points, ceilingParams);
    // Drift only ever shrinks the modeled ceiling further over time, so it
    // can only flatten a residual trend that's still downward after the tau
    // fit -- offering it for an upward residual would be directionally
    // wrong (it can't help, and searching would just return ~0).
    const drift =
      tau && tau.trendAtFitPctPerHour < -FLAT_ENOUGH_PCT_PER_HOUR
        ? fitDurabilityDriftPerHour(points, ceilingParams)
        : null;
    setResult({ tau, drift });
    setRan(true);
  };

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Fit pacing curve to this run</h3>
        <button type="button" className="chart__reset-zoom" onClick={run}>
          {ran ? "Re-run" : "Analyze"}
        </button>
      </div>
      <p className="field-group-help">
        Searches for the fade time constant (tau) that best flattens your effort trend above, holding f0/fInf/LT2 at
        whatever you've currently set on the Athlete page. This assumes you tried to hold roughly even effort
        throughout — a deliberate negative split or a very cautious start looks identical in this data, so weigh it
        against what you actually remember of the race, and eyeball the effort curve above before applying.
      </p>
      {ran && !result?.tau && (
        <p className="warning">Not enough moving time in this run to fit a trend (need a longer recording).</p>
      )}
      {result?.tau && (
        <>
          <p className="field-group-note">
            Current trend: {result.tau.trendAtCurrentPctPerHour >= 0 ? "+" : ""}
            {result.tau.trendAtCurrentPctPerHour.toFixed(1)}%/hour. Best-fit tau: {result.tau.tauMin} min (trend
            flattens to {result.tau.trendAtFitPctPerHour >= 0 ? "+" : ""}
            {result.tau.trendAtFitPctPerHour.toFixed(1)}%/hour).
          </p>
          <button type="button" className="fatox-add" onClick={() => onApplyTau(result.tau!.tauMin)}>
            Apply tau = {result.tau.tauMin} min
          </button>

          {result.tau.hitSearchBoundary && (
            <p className="field-group-note">
              This landed at the {result.tau.hitSearchBoundary} edge of the search range — treat it as a bound, not
              a precise value. The true tau may be even{" "}
              {result.tau.hitSearchBoundary === "upper" ? "larger (a slower fade)" : "smaller (a faster fade)"}.
            </p>
          )}

          {Math.abs(result.tau.trendAtFitPctPerHour) > FLAT_ENOUGH_PCT_PER_HOUR && result.tau.trendAtFitPctPerHour > 0 && (
            <p className="field-group-note">
              Even a very slow fade doesn't fully flatten this — the remaining upward trend looks more like a real
              pacing choice (e.g. a deliberate negative split or a strong finish) than a fatigue-curve mismatch.
              Durability drift can't fix this either: it only ever makes the ceiling fall faster over time, which
              would make an upward trend worse, not better.
            </p>
          )}

          {result.drift && (
            <p className="field-group-note">
              There's still a downward trend tau alone can't explain. Alternatively (lower confidence — drift and tau
              overlap too much in shape to fit both from one race), durability drift ≈{" "}
              {(result.drift.durabilityDriftPerHour * 100).toFixed(1)}%/hour would flatten it instead (trend{" "}
              {result.drift.trendAtFitPctPerHour >= 0 ? "+" : ""}
              {result.drift.trendAtFitPctPerHour.toFixed(1)}%/hour at that rate).{" "}
              <button
                type="button"
                className="fatox-add"
                onClick={() => onApplyDrift(result.drift!.durabilityDriftPerHour)}
              >
                Apply drift = {(result.drift.durabilityDriftPerHour * 100).toFixed(1)}%/hour
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
