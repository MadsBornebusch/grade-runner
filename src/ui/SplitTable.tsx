import type { ChartPoint } from "./chartData";
import { formatDuration, formatPace } from "./format";
import { computeSplits } from "./splits";

interface SplitTableProps {
  points: ChartPoint[];
  splitLengthKm?: number;
}

export function SplitTable({ points, splitLengthKm = 5 }: SplitTableProps) {
  const splits = computeSplits(points, splitLengthKm);

  return (
    <div className="split-table">
      <h3>Splits</h3>
      <table>
        <thead>
          <tr>
            <th>Km</th>
            <th>Mode</th>
            <th>+/- (m)</th>
            <th>Pace</th>
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
              <td>{formatDuration(s.timeS)}</td>
              <td>{formatDuration(s.cumulativeTimeS)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
