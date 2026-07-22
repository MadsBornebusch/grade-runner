import { Area, Brush, CartesianGrid, ComposedChart, Line, ReferenceArea, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "./chartData";
import { downsample } from "./downsample";
import { formatPace } from "./format";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

interface ElevationProfileChartProps {
  points: ChartPoint[];
}

const HEIGHT = 280;

/** Merges consecutive unpaved points into contiguous [startKm, endKm] bands
 * -- one ReferenceArea per real stretch of unpaved terrain, not one per
 * point (which would be hundreds of overlapping shaded slivers). Returns
 * `null` (not an empty array) when no point in this course carries a
 * surface classification at all, distinct from "classified and entirely
 * paved" -- callers should skip the whole overlay+legend for a course with
 * no surface data, not render it as if it were 0% unpaved. */
function computeUnpavedBands(data: ChartPoint[]): { startKm: number; endKm: number }[] | null {
  if (!data.some((p) => p.surfaceUnpaved !== undefined)) return null;
  const bands: { startKm: number; endKm: number }[] = [];
  let bandStartKm: number | null = null;
  for (const p of data) {
    if (p.surfaceUnpaved) {
      if (bandStartKm === null) bandStartKm = p.distanceKm;
    } else if (bandStartKm !== null) {
      bands.push({ startKm: bandStartKm, endKm: p.distanceKm });
      bandStartKm = null;
    }
  }
  if (bandStartKm !== null) bands.push({ startKm: bandStartKm, endKm: data[data.length - 1].distanceKm });
  return bands;
}

export function ElevationProfileChart({ points }: ElevationProfileChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800).map((p) => ({
    ...p,
    paceMinPerKm: p.speedMs > 0 ? 1000 / p.speedMs / 60 : null,
  }));
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(data);
  const unpavedBands = computeUnpavedBands(data);
  const unpavedFraction = unpavedBands ? data.filter((p) => p.surfaceUnpaved).length / data.length : null;

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
      {unpavedFraction !== null && (
        <p className="field-group-note">
          <span className="elevation-chart__legend-swatch" /> unpaved/technical terrain --{" "}
          {(unpavedFraction * 100).toFixed(0)}% of this course.
        </p>
      )}
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
            {unpavedBands?.map((band) => (
              <ReferenceArea
                key={band.startKm}
                yAxisId="elevation"
                x1={band.startKm}
                x2={band.endKm}
                fill="var(--terrain-bg)"
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
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
