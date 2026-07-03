import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "./chartData";
import { downsample } from "./downsample";
import { formatPace } from "./format";
import { useContainerWidth } from "./useContainerWidth";

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

  return (
    <div className="chart">
      <h3>Elevation &amp; pace</h3>
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
              domain={[0, "dataMax"]}
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
          </ComposedChart>
        )}
      </div>
    </div>
  );
}
