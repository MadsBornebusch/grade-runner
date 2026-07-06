import type { AnalysisResult } from "../model/analysis";
import { formatDuration } from "./format";

interface AnalysisSummaryProps {
  result: AnalysisResult;
  totalDistanceM: number;
}

export function AnalysisSummary({ result, totalDistanceM }: AnalysisSummaryProps) {
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
