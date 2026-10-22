import { useState } from "react";
import type { CeilingParams } from "../model/ceiling";
import { computeFadeTrend, fitDurabilityDriftPerHour, type EffortTrendPoint } from "../model/pacingFit";

interface PacingFitPanelProps {
  points: EffortTrendPoint[];
  ceilingParams: CeilingParams;
  onApplyDrift: (driftPerHour: number) => void;
}

/** A residual trend below this is "flat enough" -- not worth chasing
 * further or flagging as a mismatch. */
const FLAT_ENOUGH_PCT_PER_HOUR = 3;

/**
 * Fits durability drift -- an extra decay of the aerobic ceiling with time
 * on feet, on top of whatever the duration curve already says -- to one
 * recorded run.
 *
 * This panel used to fit the exponential fade curve's tau here as well,
 * and offered drift only as an alternative explanation for whatever trend
 * tau couldn't flatten. That curve is retired: the ceiling is now a
 * power law fitted as an envelope across races, and a single run cannot
 * inform a between-race curve at all. Drift is the part that was never
 * about the curve's shape -- it multiplies whatever ceiling is in force --
 * so it is the part that survives.
 */
export function PacingFitPanel({ points, ceilingParams, onApplyDrift }: PacingFitPanelProps) {
  const [result, setResult] = useState<{
    trendPctPerHour: number | null;
    drift: ReturnType<typeof fitDurabilityDriftPerHour> | null;
  } | null>(null);
  const [ran, setRan] = useState(false);

  const run = () => {
    const trend = computeFadeTrend(points, ceilingParams);
    // Drift only ever shrinks the modeled ceiling further over time, so it
    // can only flatten a residual trend that's already downward -- offering
    // it for an upward one would be directionally wrong (it can't help, and
    // searching would just return ~0).
    const drift =
      trend && trend.slopePerHour * 100 < -FLAT_ENOUGH_PCT_PER_HOUR ? fitDurabilityDriftPerHour(points, ceilingParams) : null;
    setResult({ trendPctPerHour: trend ? trend.slopePerHour * 100 : null, drift });
    setRan(true);
  };

  return (
    <details className="lab card">
      <summary>Lab: did you fade on this run?</summary>
      <div className="lab__body">
        <p className="help">
          Checks whether your effort held level against your ceiling, and if it fell away, how much durability drift
          would explain it. This assumes you tried to hold even effort: a planned negative split or a careful start
          looks the same in the data, so weigh it against what you remember of the run.
        </p>
        <button type="button" className="button-ghost button-small" onClick={run}>
          {ran ? "Check again" : "Check this run"}
        </button>
        {ran && result?.trendPctPerHour === null && (
          <p className="help">Not enough moving time in this run to see a trend. It needs a longer recording.</p>
        )}
        {result?.trendPctPerHour !== null && result?.trendPctPerHour !== undefined && (
          <>
            <p className="help">
              Effort against your ceiling changed by {result.trendPctPerHour >= 0 ? "+" : ""}
              {result.trendPctPerHour.toFixed(1)}% per hour.
              {Math.abs(result.trendPctPerHour) <= FLAT_ENOUGH_PCT_PER_HOUR &&
                " That's flat enough: your ceiling already describes this run."}
            </p>

            {result.trendPctPerHour > FLAT_ENOUGH_PCT_PER_HOUR && (
              <p className="help">
                Your effort rose through this run. That looks like a pacing choice, a negative split or a strong
                finish, rather than anything the ceiling gets wrong. Drift can't describe it: it only ever makes the
                ceiling fall faster.
              </p>
            )}

            {result.drift && (
              <>
                <p className="help">
                  A drift of {(result.drift.durabilityDriftPerHour * 100).toFixed(1)}% per hour would flatten this
                  (what's left: {result.drift.trendAtFitPctPerHour >= 0 ? "+" : ""}
                  {result.drift.trendAtFitPctPerHour.toFixed(1)}% per hour). One run is thin evidence, so only apply it
                  if this is how you usually fade.
                </p>
                <button
                  type="button"
                  className="button-ghost button-small"
                  onClick={() => onApplyDrift(result.drift!.durabilityDriftPerHour)}
                >
                  Apply {(result.drift.durabilityDriftPerHour * 100).toFixed(1)}% per hour
                </button>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}
