import { Brush, CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "./chartData";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

interface FuelChartProps {
  points: ChartPoint[];
}

const HEIGHT = 220;

export function FuelChart({ points }: FuelChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800);
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(data);

  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">Glycogen balance</h3>
        {isZoomed && (
          <button type="button" className="button-ghost button-small" onClick={reset}>
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
              formatter={(value) => [`${Number(value).toFixed(0)} g`, "glycogen"]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <ReferenceLine y={0} stroke="var(--danger)" strokeDasharray="4 4" label="bonk" />
            <Line
              type="monotone"
              dataKey="glycogenG"
              stroke="var(--brand)"
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
              stroke="var(--border-strong)"
              fill="var(--surface-2)"
              tickFormatter={(value: number) => value.toFixed(0)}
            />
          </LineChart>
        )}
      </div>
    </div>
  );
}
