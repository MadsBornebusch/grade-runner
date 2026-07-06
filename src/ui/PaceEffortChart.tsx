import { Brush, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { downsample } from "./downsample";
import { formatPace } from "./format";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

export interface PaceEffortPoint {
  distanceKm: number;
  paceMinPerKm: number | null;
  effortPct: number | null;
}

interface PaceEffortChartProps {
  /** The recorded run: actual pace and actual effort (% of ceiling) per segment. */
  actual: PaceEffortPoint[];
  /** The Planning-mode solved pace at the same theta for this course. */
  planned: { distanceKm: number; paceMinPerKm: number | null }[];
  /** Planning's solved effort fraction (0-1), drawn as a reference line. Null if no plan available. */
  plannedThetaFraction: number | null;
}

const HEIGHT = 300;

/**
 * Overlays the recorded run's actual pace and per-segment effort (% of your
 * modeled aerobic ceiling at that point in the race) against the Planning
 * page's solved "optimal" pace for the same course -- so a part of the
 * course run harder than sustainable shows up as the effort line poking
 * above the 100% ceiling reference, not just as a vague pace wobble.
 */
export function PaceEffortChart({ actual, planned, plannedThetaFraction }: PaceEffortChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const actualData = downsample(actual, 800);
  const plannedData = downsample(planned, 800);
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(actualData);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Pace &amp; effort vs. plan</h3>
        {isZoomed && (
          <button type="button" className="chart__reset-zoom" onClick={reset}>
            Reset zoom
          </button>
        )}
      </div>
      <p className="field-group-help">
        Actual pace and effort (solid) against the Planning page's solved pace for this course (dashed). The red
        effort line is your actual power as a fraction of your modeled aerobic ceiling at that point in the race —
        it crossing above the grey 100% line marks a stretch run harder than the model thinks was sustainable there.
      </p>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <ComposedChart
            width={width}
            height={HEIGHT}
            data={actualData}
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
            <YAxis
              yAxisId="pace"
              reversed
              label={{ value: "min/km", angle: -90, position: "insideLeft" }}
            />
            <YAxis
              yAxisId="effort"
              orientation="right"
              label={{ value: "effort %", angle: 90, position: "insideRight" }}
            />
            <Tooltip
              formatter={(value, name) =>
                name === "Effort %"
                  ? [`${Number(value).toFixed(0)}%`, name]
                  : [formatPace(1000 / (Number(value) * 60)), name]
              }
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <Legend />
            <ReferenceLine yAxisId="effort" y={100} stroke="var(--text)" strokeOpacity={0.4} strokeDasharray="3 3" />
            {plannedThetaFraction !== null && (
              <ReferenceLine
                yAxisId="effort"
                y={plannedThetaFraction * 100}
                stroke="var(--accent)"
                strokeDasharray="3 3"
                label={{ value: "planned", position: "insideTopLeft", fill: "var(--accent)", fontSize: 11 }}
              />
            )}
            <Line
              yAxisId="pace"
              data={plannedData}
              type="monotone"
              dataKey="paceMinPerKm"
              name="Planned pace"
              stroke="var(--accent)"
              strokeDasharray="4 4"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="pace"
              data={actualData}
              type="monotone"
              dataKey="paceMinPerKm"
              name="Actual pace"
              stroke="var(--text-h)"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="effort"
              data={actualData}
              type="monotone"
              dataKey="effortPct"
              name="Effort %"
              stroke="#e05252"
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
