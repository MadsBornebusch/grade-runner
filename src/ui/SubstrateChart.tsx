import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";

export interface SubstratePoint {
  distanceKm: number;
  cumulativeCarbG: number;
  cumulativeFatG: number;
}

interface SubstrateChartProps {
  points: SubstratePoint[];
}

const HEIGHT = 220;

export function SubstrateChart({ points }: SubstrateChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800);

  return (
    <div className="chart">
      <h3>Carb vs. fat burned</h3>
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
              formatter={(value, name) => [`${Number(value).toFixed(0)} g`, name]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="cumulativeCarbG"
              name="carb"
              stroke="var(--accent)"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="cumulativeFatG"
              name="fat"
              stroke="var(--text-h)"
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
