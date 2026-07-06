import { Area, Brush, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "./chartData";
import { downsample } from "./downsample";
import { formatPace } from "./format";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

interface ElevationProfileChartProps {
  points: ChartPoint[];
}

const HEIGHT = 280;

export function ElevationProfileChart({ points }: ElevationProfileChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800).map((p) => ({
    ...p,
    paceMinPerKm: p.speedMs > 0 ? 1000 / p.speedMs / 60 : null,
  }));
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(data);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Elevation &amp; pace</h3>
        {isZoomed && (
          <button type="button" className="chart__reset-zoom" onClick={reset}>
            Reset zoom
          </button>
        )}
      </div>
      {/* isAnimationActive=false: Recharts otherwise sweeps the series in via
          an animated clip-path, which reads as a truncated chart if you
          glance at it (or screenshot it) before the ~1.5s animation finishes. */}
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <ComposedChart
            width={width}
            height={HEIGHT}
            data={data}
            margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="distanceKm"
              type="number"
              domain={domain ?? [0, "dataMax"]}
              allowDataOverflow={isZoomed}
              tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: "km", position: "insideBottomRight", offset: -4 }}
            />
            <YAxis yAxisId="elevation" label={{ value: "m", angle: -90, position: "insideLeft" }} />
            <YAxis
              yAxisId="pace"
              orientation="right"
              reversed
              label={{ value: "min/km", angle: 90, position: "insideRight" }}
            />
            <Tooltip
              formatter={(value, name) =>
                name === "paceMinPerKm"
                  ? [formatPace(1000 / (Number(value) * 60)), "pace"]
                  : [`${Number(value).toFixed(0)} m`, "elevation"]
              }
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <Area
              yAxisId="elevation"
              type="monotone"
              dataKey="elevationM"
              fill="var(--accent-bg)"
              stroke="var(--accent-border)"
              isAnimationActive={false}
            />
            <Line
              yAxisId="pace"
              type="monotone"
              dataKey="paceMinPerKm"
              stroke="var(--text-h)"
              dot={false}
              strokeWidth={1.5}
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
          </ComposedChart>
        )}
      </div>
    </div>
  );
}
