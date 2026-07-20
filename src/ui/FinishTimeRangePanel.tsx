import { useState } from "react";
import type { CourseSegment } from "../gpx/pipeline";
import type { CeilingParams } from "../model/ceiling";
import { predictFinishTimeRange, type FinishTimeRangeResult } from "../model/finishTimeRange";
import type { EffortTrendPoint } from "../model/pacingFit";
import type { SolverInputs } from "../model/solver";
import { formatDuration } from "./format";

interface FinishTimeRangePanelProps {
  /** The races/raceDates behind the Athlete tab's most recent tau/fInf fit
   * -- null until a fit has actually been run there. */
  fittedRaces: { races: EffortTrendPoint[][]; raceDates: (Date | null)[] } | null;
  ceilingParams: CeilingParams;
  solverBaseInputs: Omit<SolverInputs, "segments" | "ceilingParams">;
  targetSegments: CourseSegment[];
}

/** Fraction of bootstrap resamples that failed to clear the support gate
 * above which the resulting band is flagged as possibly optimistic (too
 * narrow) rather than presented as a plain number. */
const HIGH_SKIP_RATE_WARNING_THRESHOLD = 0.4;

/**
 * On-demand (not a live useMemo): bootstrapping ~100 tau refits plus a
 * findSustainableTheta solve each is too expensive to recompute on every
 * keystroke, so this is an explicit button with its own loading state.
 */
export function FinishTimeRangePanel({ fittedRaces, ceilingParams, solverBaseInputs, targetSegments }: FinishTimeRangePanelProps) {
  const [result, setResult] = useState<FinishTimeRangeResult | "insufficient" | null>(null);
  const [computing, setComputing] = useState(false);

  if (!fittedRaces) {
    return (
      <p className="field-group-note">
        Fit tau (or fInf/tau) from your run library on the Athlete tab to unlock a predicted finish-time range here.
      </p>
    );
  }

  const handleClick = async () => {
    setComputing(true);
    setResult(null);
    try {
      const range = await predictFinishTimeRange(
        fittedRaces.races,
        fittedRaces.raceDates,
        ceilingParams,
        solverBaseInputs,
        targetSegments,
      );
      setResult(range ?? "insufficient");
    } finally {
      setComputing(false);
    }
  };

  const totalSamples = result && result !== "insufficient" ? result.sampleCount + result.skippedCount : 0;
  const skipRate = result && result !== "insufficient" && totalSamples > 0 ? result.skippedCount / totalSamples : 0;

  return (
    <div className="finish-time-range">
      <button type="button" onClick={handleClick} disabled={computing}>
        {computing ? "Estimating…" : "Estimate finish-time range"}
      </button>

      {result === "insufficient" && (
        <p className="warning">
          Not enough training data to estimate a range yet -- needs at least 2 races that actually inform the tau
          fit (see the informative-race-count notes on the Athlete tab).
        </p>
      )}

      {result && result !== "insufficient" && (
        <>
          <p className="field-group-note">
            Range: {formatDuration(result.lowFinishTimeS)}–{formatDuration(result.highFinishTimeS)} (median{" "}
            {formatDuration(result.medianFinishTimeS)}), point estimate {formatDuration(result.pointEstimateFinishTimeS)}.
          </p>
          <p className="field-group-help">
            Reflects how sensitive this prediction is to your fitted fade rate (tau), given how well your own
            training data pins it down -- not weather, fueling execution, or model error on race day. Based on{" "}
            {result.sampleCount} usable bootstrap resamples ({result.skippedCount} skipped for not clearing the same
            support bar the main fit needed).
          </p>
          {skipRate > HIGH_SKIP_RATE_WARNING_THRESHOLD && (
            <p className="warning">
              Many resamples couldn't produce a usable fit -- this range may be optimistic (narrower than the true
              uncertainty).
            </p>
          )}
        </>
      )}
    </div>
  );
}
