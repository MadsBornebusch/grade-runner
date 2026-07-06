import type { SimulationResult } from "../model/solver";
import { formatDuration } from "./format";

interface ResultsSummaryProps {
  theta: number;
  result: SimulationResult;
  totalDistanceM: number;
}

export function ResultsSummary({ theta, result, totalDistanceM }: ResultsSummaryProps) {
  const reachedKm = result.segments.length
    ? result.segments[result.segments.length - 1].cumulativeDistance3D / 1000
    : 0;
  const totalKm = totalDistanceM / 1000;

  return (
    <div className={`results-summary ${result.feasible ? "results-summary--ok" : "results-summary--warn"}`}>
      <div
        className="results-summary__stat"
        title="The largest fraction of your sustainable aerobic ceiling the solver found you can hold the whole way without bonking. 100% means fueling isn't the limit — you're purely aerobically capped; below 100% means the plan backs off pace to protect your glycogen to the finish."
      >
        <span className="results-summary__label">Effort</span>
        <span className="results-summary__value">{(theta * 100).toFixed(0)}%</span>
      </div>
      <div className="results-summary__stat">
        <span className="results-summary__label">{result.feasible ? "Predicted finish" : "Time to bonk"}</span>
        <span className="results-summary__value">{formatDuration(result.finishTimeS)}</span>
      </div>
      {!result.feasible && (
        <p className="results-summary__warning">
          Bonk predicted at {reachedKm.toFixed(1)} km of {totalKm.toFixed(1)} km — increase fueling,
          slow down, or carry more glycogen reserve.
        </p>
      )}
    </div>
  );
}
