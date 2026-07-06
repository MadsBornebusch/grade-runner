import { Brush, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

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
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(data);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Carb vs. fat burned</h3>
        {isZoomed && (
          <button type="button" className="chart__reset-zoom" onClick={reset}>
            Reset zoom
          </button>
        )}
      </div>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <LineChart width={width} height={HEIGHT} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="distanceKm"
              type="number"
              domain={domain ?? [0, "dataMax"]}
              allowDataOverflow={isZoomed}
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
            <Brush
              dataKey="distanceKm"
              height={22}
              startIndex={startIndex}
              endIndex={endIndex}
              onChange={onBrushChange}
              travellerWidth={10}
              stroke="var(--accent-border)"
              fill="var(--bg-alt)"
              tickFormatter={(value: number) => value.toFixed(0)}
            />
          </LineChart>
        )}
      </div>
    </div>
  );
}
