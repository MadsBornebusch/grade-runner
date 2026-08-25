import type { ChartPoint } from "./chartData";
import { formatDuration, formatPace } from "./format";
import { computeCustomSplits, computeSplits } from "./splits";
import { useNumberField } from "./useNumberField";

interface SplitTableProps {
  points: ChartPoint[];
  splitLengthKm?: number;
  /** Present iff the split length should be user-editable right here --
   * omit for a read-only table at the default length. */
  onSplitLengthChange?: (km: number) => void;
  /** Points saved from RouteMap.tsx (aid-station planning) -- when
   * non-empty, splits between THESE distances instead of fixed km
   * intervals, so the table reads as "leg to aid station 1", "leg to aid
   * station 2", etc. Empty/omitted is byte-for-byte the old fixed-interval
   * table. */
  savedPointsKm?: number[];
  /** Present alongside a non-empty savedPointsKm so the table itself offers
   * a way back to fixed-interval splits, not just RouteMap's own control. */
  onClearSavedPoints?: () => void;
}

export function SplitTable({ points, splitLengthKm = 5, onSplitLengthChange, savedPointsKm = [], onClearSavedPoints }: SplitTableProps) {
  const usingSavedPoints = savedPointsKm.length > 0;
  const splits = usingSavedPoints ? computeCustomSplits(points, savedPointsKm) : computeSplits(points, splitLengthKm);
  const hasHrEstimate = splits.some((s) => s.avgEstimatedHeartRateBpm !== null);
  const hasCarbs = splits.some((s) => s.carbG > 0);
  // Only committed once the typed text parses to a positive number -- same
  // buffering useNumberField exists for -- so clearing the field to retype
  // it doesn't get reverted mid-edit by the >0 guard rejecting "".
  const lengthField = useNumberField(splitLengthKm, (v) => {
    if (v > 0) onSplitLengthChange?.(v);
  });

  return (
    <div className="split-table">
      <div className="split-table__header">
        <h3>Splits</h3>
        {usingSavedPoints ? (
          onClearSavedPoints && (
            <button type="button" className="chart__reset-zoom" onClick={onClearSavedPoints}>
              Back to fixed-distance splits
            </button>
          )
        ) : (
          onSplitLengthChange && (
            <label className="split-table__length-control">
              every
              <input type="number" min={0.1} step={0.5} {...lengthField} />
              km
            </label>
          )
        )}
      </div>
      {usingSavedPoints && (
        <p className="field-group-help">
          Legs between your {savedPointsKm.length} saved point{savedPointsKm.length === 1 ? "" : "s"} on the map above, aid-station style
          -- not fixed-distance splits.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Km</th>
            <th>Mode</th>
            <th>+/- (m)</th>
            <th>Pace</th>
            {hasHrEstimate && <th>Est. HR</th>}
            <th>Split time</th>
            <th>Cumulative</th>
            {hasCarbs && <th>Carbs</th>}
          </tr>
        </thead>
        <tbody>
          {splits.map((s) => (
            <tr key={s.index}>
              <td>
                {s.startKm.toFixed(1)}&ndash;{s.endKm.toFixed(1)}
              </td>
              <td>{s.mode}</td>
              <td>
                +{s.elevationGainM.toFixed(0)} / -{s.elevationLossM.toFixed(0)}
              </td>
              <td>{formatPace(s.avgSpeedMs)}</td>
              {hasHrEstimate && <td>{s.avgEstimatedHeartRateBpm !== null ? `${s.avgEstimatedHeartRateBpm.toFixed(0)} bpm` : "—"}</td>}
              <td>{formatDuration(s.timeS)}</td>
              <td>{formatDuration(s.cumulativeTimeS)}</td>
              {hasCarbs && (
                <td>
                  {s.carbG.toFixed(0)}g <span className="split-table__cumulative-note">({s.cumulativeCarbG.toFixed(0)}g total)</span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
