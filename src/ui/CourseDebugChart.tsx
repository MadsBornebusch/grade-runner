import { Brush, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import type { RawCourseStats } from "../gpx/pipeline";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

export interface ProcessedDebugPoint {
  distanceKm: number;
  elevationM: number;
}

interface CourseDebugChartProps {
  raw: RawCourseStats;
  processed: ProcessedDebugPoint[];
  processedDistanceM: number;
  processedElevationGain: number;
  segmentLengthM: number;
  smoothingWindowM: number;
}

const HEIGHT = 260;

/**
 * Shows raw (unsmoothed, unresampled) elevation against what the model
 * actually uses, plus distance/gain numbers for both -- so "am I losing real
 * information to filtering" is something you can look at, not just take on
 * faith. See PLAN.md §5 GPX pipeline note for why gain is inherently
 * scale-sensitive on rough terrain (no single "true" figure exists) while
 * distance is a real, linearly-consequential number that shrinks as segment
 * length grows (it cuts corners on turns/switchbacks).
 */
export function CourseDebugChart({
  raw,
  processed,
  processedDistanceM,
  processedElevationGain,
  segmentLengthM,
  smoothingWindowM,
}: CourseDebugChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();

  const rawData = downsample(
    raw.series.map((p) => ({ distanceKm: p.distanceM / 1000, elevation: p.elevation })),
    800,
  );
  const processedData = downsample(processed, 800);
  // Brush drives a shared km domain (see useDomainZoom) rather than
  // Brush's own index-slicing, since raw/processed are two independent
  // data arrays with different lengths -- a domain applies to both no
  // matter which array each Line was given.
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(processedData);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Course processing debug</h3>
        {isZoomed && (
          <button type="button" className="chart__reset-zoom" onClick={reset}>
            Reset zoom
          </button>
        )}
      </div>
      <p className="field-group-help">
        Raw GPS/barometric elevation (dashed) vs. what the model actually uses after your Segment
        length / Smoothing window settings (solid). Total elevation gain is naturally scale-sensitive
        on rough terrain — there's no single "true" number, more resolution always finds more gain —
        so treat it as a reference point, not a target to hit. Distance is different: it shrinks in a
        straight line as segment length grows, because longer segments cut corners on turns and
        switchbacks, and that directly moves your predicted finish time.
      </p>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <ComposedChart
            width={width}
            height={HEIGHT}
            data={processedData}
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
              allowDuplicatedCategory={false}
            />
            <YAxis label={{ value: "m", angle: -90, position: "insideLeft" }} />
            <Tooltip
              formatter={(value, name) => [`${Number(value).toFixed(0)} m`, name]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <Legend />
            <Line
              data={rawData}
              type="monotone"
              dataKey="elevation"
              name="raw"
              stroke="var(--text)"
              strokeOpacity={0.5}
              strokeDasharray="3 3"
              dot={false}
              strokeWidth={1}
              isAnimationActive={false}
            />
            <Line
              data={processedData}
              type="monotone"
              dataKey="elevationM"
              name="processed"
              stroke="var(--accent)"
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
          </ComposedChart>
        )}
      </div>
      <table className="debug-stats-table">
        <thead>
          <tr>
            <th></th>
            <th>Distance</th>
            <th>Elevation gain</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Raw (no processing)</td>
            <td>{(raw.distanceM / 1000).toFixed(2)} km</td>
            <td>{raw.elevationGain.toFixed(0)} m</td>
          </tr>
          <tr>
            <td>
              Current settings ({segmentLengthM}m / {smoothingWindowM}m)
            </td>
            <td>{(processedDistanceM / 1000).toFixed(2)} km</td>
            <td>{processedElevationGain.toFixed(0)} m</td>
          </tr>
        </tbody>
      </table>
      <p className="field-group-help">
        What actually drives your predicted pace and bonk point — the energy cost integrated over
        the whole course — stays comparatively stable across a wide range of smoothing settings,
        even though the gain number above swings a lot. If the distance row looks short of what you
        know the course to be, try a smaller segment length; just keep the smoothing window at a
        real value (not near 0) so the gradient calculation stays protected from GPS noise.
      </p>
    </div>
  );
}
