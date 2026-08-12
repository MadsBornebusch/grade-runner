import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { TheoreticalFatOxPoint } from "../model/substrate";
import { useContainerWidth } from "./useContainerWidth";

interface FatOxCurveChartProps {
  points: TheoreticalFatOxPoint[];
}

const HEIGHT = 220;

/**
 * Theoretical fat/carb-oxidation-vs-pace curve, generated from LT1/LT2/
 * VO2max alone (see substrate.ts's generateTheoreticalFatOxCurve) -- shown
 * whenever no real metabolic-cart points have been entered, so an athlete
 * without lab data still sees what the model assumes their fuel split
 * looks like, not just two abstract threshold numbers. A small, fixed-size
 * curve (not a course time series), so unlike this app's other charts it
 * doesn't need zoom/brush/downsampling.
 */
export function FatOxCurveChart({ points }: FatOxCurveChartProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  // Recharts plots left-to-right by array order, not by X value -- sort so
  // a fast (small pace-number) point never renders after a slow one.
  const data = [...points].sort((a, b) => a.paceMinPerKm - b.paceMinPerKm);

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Theoretical fat oxidation curve</h3>
      </div>
      <p className="field-group-help">
        Derived from LT1, LT2, and VO2max alone (no lab data) -- the same logistic fuel-split model a real
        fat-ox test would calibrate, just anchored on your thresholds instead of measured points. Enter your own
        fat-ox curve above to replace this with real data.
      </p>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <LineChart width={width} height={HEIGHT} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="paceMinPerKm"
              type="number"
              domain={["dataMin", "dataMax"]}
              reversed
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{ value: "min/km", position: "insideBottomRight", offset: -4 }}
            />
            <YAxis label={{ value: "g/min", angle: -90, position: "insideLeft" }} />
            <Tooltip
              formatter={(value, name) => [`${Number(value).toFixed(2)} g/min`, name]}
              labelFormatter={(v) => `${Number(v).toFixed(2)} min/km`}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="fatGPerMin"
              name="fat"
              stroke="var(--text-h)"
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="carbGPerMin"
              name="carb"
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
