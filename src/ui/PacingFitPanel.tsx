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
    <div className="chart">
      <div className="chart__header">
        <h3>Check this run against your ceiling</h3>
        <button type="button" className="chart__reset-zoom" onClick={run}>
          {ran ? "Re-run" : "Analyze"}
        </button>
      </div>
      <p className="field-group-help">
        Measures whether your effort held level against your fitted aerobic ceiling, and if it fell away, how much
        durability drift would account for it. This assumes you tried to hold roughly even effort throughout — a
        deliberate negative split or a very cautious start looks identical in this data, so weigh it against what you
        actually remember of the run, and eyeball the effort curve above before applying anything.
      </p>
      {ran && result?.trendPctPerHour === null && (
        <p className="warning">Not enough moving time in this run to fit a trend (need a longer recording).</p>
      )}
      {result?.trendPctPerHour !== null && result?.trendPctPerHour !== undefined && (
        <>
          <p className="field-group-note">
            Effort trend against your ceiling: {result.trendPctPerHour >= 0 ? "+" : ""}
            {result.trendPctPerHour.toFixed(1)}%/hour.
            {Math.abs(result.trendPctPerHour) <= FLAT_ENOUGH_PCT_PER_HOUR &&
              " That's flat enough — your ceiling already describes this run."}
          </p>

          {result.trendPctPerHour > FLAT_ENOUGH_PCT_PER_HOUR && (
            <p className="field-group-note">
              Your effort rose through this run. That looks like a pacing choice — a negative split or a strong
              finish — rather than anything the ceiling gets wrong. Durability drift can't describe it either: it only
              ever makes the ceiling fall faster, which would make an upward trend worse.
            </p>
          )}

          {result.drift && (
            <p className="field-group-note">
              Durability drift of {(result.drift.durabilityDriftPerHour * 100).toFixed(1)}%/hour would flatten this
              (residual trend {result.drift.trendAtFitPctPerHour >= 0 ? "+" : ""}
              {result.drift.trendAtFitPctPerHour.toFixed(1)}%/hour at that rate). One run is thin evidence for it —
              apply it only if this matches how you fade generally, not just on this day.{" "}
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
