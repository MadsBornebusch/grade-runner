import type { AnalysisResult } from "../model/analysis";
import type { CourseSummaryStats } from "./chartData";
import { formatDuration, formatMinPerKm } from "./format";

interface AnalysisSummaryProps {
  result: AnalysisResult;
  totalDistanceM: number;
  /** Whole-run averages (pace, grade-adjusted pace, heart rate) -- see
   * chartData.ts's summarizeChartPoints. Heart rate can be the ACTUAL
   * recorded average, a calibration ESTIMATE (no HR sensor data at all,
   * or no calibration fit yet), or a MIX of the two (sensor dropout
   * mid-run) -- summaryStats.avgHrSource says which, and this component
   * labels the value accordingly rather than presenting all three the
   * same way. */
  summaryStats: CourseSummaryStats;
}

export function AnalysisSummary({ result, totalDistanceM, summaryStats }: AnalysisSummaryProps) {
  const bonkSegment = result.bonkIndex !== null ? result.segments.find((s) => s.index === result.bonkIndex) : undefined;

  return (
    <div className={`results-summary ${result.bonked ? "results-summary--warn" : "results-summary--ok"}`}>
      <div
        className="results-summary__stat"
        title="The moving-time-weighted average of your actual power vs. your sustainable aerobic ceiling at each point in the run. Unlike Planning's Effort, this is descriptive, not a solved target -- it can read over 100% if you ran harder than the ceiling model says was sustainable for that duration (a hard push, or a sign your athlete settings don't quite match your current fitness)."
      >
        <span className="results-summary__label">Effort</span>
        <span className="results-summary__value">{(result.avgEffortFraction * 100).toFixed(0)}%</span>
      </div>
      <div className="results-summary__stat">
        <span className="results-summary__label">Elapsed time</span>
        <span className="results-summary__value">{formatDuration(result.totalElapsedTimeS)}</span>
      </div>
      <div className="results-summary__stat">
        <span className="results-summary__label">Moving time</span>
        <span className="results-summary__value">{formatDuration(result.totalMovingTimeS)}</span>
      </div>

      {(summaryStats.avgPaceMinPerKm !== null || summaryStats.avgHrBpm !== null) && (
        <div className="results-summary__averages">
          <span title="From your file's recorded distance and time.">Avg pace {formatMinPerKm(summaryStats.avgPaceMinPerKm)}</span>
          <span title="Grade-adjusted pace -- your recorded pace re-expressed as an equivalent flat-ground pace, via the same cost model Planning uses. Modeled, not a raw recording.">
            GAP {formatMinPerKm(summaryStats.avgGapMinPerKm)}
          </span>
          {summaryStats.avgHrBpm !== null && (
            <span
              title={
                summaryStats.avgHrSource === "recorded"
                  ? "From your file's recorded heart rate."
                  : summaryStats.avgHrSource === "mixed"
                    ? "Partly your file's recorded heart rate, partly estimated from your HR-effort calibration where the recording had gaps."
                    : "Estimated from your HR-effort calibration -- this run has no recorded heart rate to show instead."
              }
            >
              Avg HR {summaryStats.avgHrSource !== "recorded" ? "~" : ""}
              {Math.round(summaryStats.avgHrBpm)} bpm
              {summaryStats.avgHrSource !== "recorded" && (
                <sup className="results-summary__estimated-flag">{summaryStats.avgHrSource === "mixed" ? "mixed" : "est"}</sup>
              )}
            </span>
          )}
        </div>
      )}

      {result.bonked && bonkSegment && (
        <p className="results-summary__warning">
          Glycogen hit reserve at {(bonkSegment.cumulativeDistance3D / 1000).toFixed(1)} km of{" "}
          {(totalDistanceM / 1000).toFixed(1)} km ({formatDuration(bonkSegment.cumulativeElapsedTimeS)} elapsed) —
          this is where a bonk would have (or did) hit given the stated fueling.
        </p>
      )}
    </div>
  );
}
