import { Brush, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
import { downsample } from "./downsample";
import { useContainerWidth } from "./useContainerWidth";
import { useDomainZoom } from "./useDomainZoom";

export interface PowerHrPoint {
  distanceKm: number;
  measuredPowerW: number | null;
  modeledPowerW: number;
  heartRateBpm: number | null;
}

interface PowerHrChartProps {
  points: PowerHrPoint[];
  hasPower: boolean;
  hasHeartRate: boolean;
}

const HEIGHT = 280;

/**
 * Compares the model's speed/gradient-based power estimate against whatever
 * a device measured, plus heart rate. Important caveat baked into the help
 * text below: a footpod's "power" (e.g. Stryd) is not metabolic power --
 * it's a biomechanical estimate that *correlates* well with metabolic power
 * (R^2 ~0.8 in published validation studies) but on a different scale (a 1
 * W/kg change in true metabolic cost shows up as roughly a 0.2 W/kg change
 * in Stryd's number). So a several-fold gap between the two lines here is
 * expected, not a sign either one is wrong -- they're each on their own
 * axis so what's actually comparable is whether they RISE AND FALL together
 * (same shape), not whether they land on the same numbers.
 */
export function PowerHrChart({ points, hasPower, hasHeartRate }: PowerHrChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const data = downsample(points, 800);
  const { startIndex, endIndex, isZoomed, domain, onBrushChange, reset } = useDomainZoom(data);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Measured vs. modeled power{hasHeartRate ? " & heart rate" : ""}</h3>
        {isZoomed && (
          <button type="button" className="chart__reset-zoom" onClick={reset}>
            Reset zoom
          </button>
        )}
      </div>
      <p className="field-group-help">
        {hasPower
          ? "Modeled power (dashed) comes purely from speed + gradient via the Minetti cost curve. If your device measured power (solid), note it's on its own axis: a footpod's \"power\" (e.g. Stryd) correlates with metabolic power but isn't the same quantity or scale -- a multi-fold gap is normal. What's worth looking at is whether the two rise and fall together, not whether they match numerically."
          : "This device didn't record power, so only the model's own speed/gradient-based estimate is shown."}
        {hasHeartRate && " Heart rate drifting upward while power/pace doesn't is a classic sign of accumulating fatigue."}
      </p>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <ComposedChart width={width} height={HEIGHT} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="distanceKm"
              type="number"
              domain={domain ?? [0, "dataMax"]}
              allowDataOverflow={isZoomed}
              tickFormatter={(v: number) => v.toFixed(0)}
              label={{ value: "km", position: "insideBottomRight", offset: -4 }}
            />
            <YAxis yAxisId="modeledPower" orientation="left" label={{ value: "modeled W", angle: -90, position: "insideLeft" }} />
            {hasPower && (
              <YAxis
                yAxisId="measuredPower"
                orientation="left"
                label={{ value: "measured W", angle: -90, position: "insideLeft" }}
              />
            )}
            {hasHeartRate && (
              <YAxis
                yAxisId="hr"
                orientation="right"
                label={{ value: "bpm", angle: 90, position: "insideRight" }}
              />
            )}
            <Tooltip
              formatter={(value, name) => [name === "Heart rate" ? `${Number(value).toFixed(0)} bpm` : `${Number(value).toFixed(0)} W`, name]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} km`}
            />
            <Legend />
            {hasPower && (
              <Line
                yAxisId="measuredPower"
                type="monotone"
                dataKey="measuredPowerW"
                name="Measured power"
                stroke="var(--text-h)"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            )}
            <Line
              yAxisId="modeledPower"
              type="monotone"
              dataKey="modeledPowerW"
              name="Modeled power"
              stroke="var(--accent)"
              strokeDasharray="4 4"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            {hasHeartRate && (
              <Line
                yAxisId="hr"
                type="monotone"
                dataKey="heartRateBpm"
                name="Heart rate"
                stroke="#e05252"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            )}
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
