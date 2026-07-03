import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "./chartData";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";

interface FuelChartProps {
  points: ChartPoint[];
  reserveG: number;
}

const HEIGHT = 220;

export function FuelChart({ points, reserveG }: FuelChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800);

  return (
    <div className="chart">
      <h3>Glycogen balance</h3>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <LineChart width={width} height={HEIGHT} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="distanceKm"
              type="number"
              domain={[0, "dataMax"]}
              tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: "km", position: "insideBottomRight", offset: -4 }}
            />
            <YAxis label={{ value: "g", angle: -90, position: "insideLeft" }} />
            <Tooltip
              formatter={(value) => [`${Number(value).toFixed(0)} g`, "glycogen"]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <ReferenceLine y={reserveG} stroke="#e05252" strokeDasharray="4 4" label="reserve" />
            <Line
              type="monotone"
              dataKey="glycogenG"
              stroke="var(--accent)"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </div>
    </div>
  );
}
