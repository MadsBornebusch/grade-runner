import type { ChartPoint } from "./chartData";
import { formatDuration, formatPace } from "./format";
import { computeSplits } from "./splits";

interface SplitTableProps {
  points: ChartPoint[];
  splitLengthKm?: number;
  /** Present iff the split length should be user-editable right here --
   * omit for a read-only table at the default length. */
  onSplitLengthChange?: (km: number) => void;
}

export function SplitTable({ points, splitLengthKm = 5, onSplitLengthChange }: SplitTableProps) {
  const splits = computeSplits(points, splitLengthKm);
  const hasHrEstimate = splits.some((s) => s.avgEstimatedHeartRateBpm !== null);

  return (
    <div className="split-table">
      <div className="split-table__header">
        <h3>Splits</h3>
        {onSplitLengthChange && (
          <label className="split-table__length-control">
            every
            <input
              type="number"
              min={0.1}
              step={0.5}
              value={splitLengthKm}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (v > 0) onSplitLengthChange(v);
              }}
            />
            km
          </label>
        )}
      </div>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
