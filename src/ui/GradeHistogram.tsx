import { Bar, BarChart, Cell, Tooltip, XAxis, YAxis } from "recharts";
import { type GradeBin } from "./chartData";
import { useContainerWidth } from "./useContainerWidth";

interface GradeHistogramProps {
  bins: GradeBin[];
}

const HEIGHT = 220;

/** Distance is the honest axis here: time would make the steep uphill bins
 * tower over everything purely because they're slow, which reads as "this
 * course is mostly steep climbing" when it may be a few hundred metres of
 * it. */
function formatKm(distanceM: number): string {
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.round(distanceM)} m`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Where the plan's distance sits across gradient, with the two bins-of-note
 * called out: uphill bins the plan WALKS (walking beats running for the
 * same effort past a certain steepness -- an emergent result, not a rule),
 * and descent bins held at the descent-speed cap rather than by the power
 * target, i.e. braking.
 */
export function GradeHistogram({ bins }: GradeHistogramProps) {
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  if (bins.length === 0) return null;

  const data = bins.map((b) => ({
    ...b,
    // Bin midpoint as a percentage, which is what a runner reads a gradient as.
    gradePct: ((b.fromGradient + b.toGradient) / 2) * 100,
    distanceKm: b.distanceM / 1000,
  }));
  const walkKm = bins.filter((b) => b.hasWalking).reduce((a, b) => a + b.distanceM, 0) / 1000;
  const brakeKm = bins.filter((b) => b.hasBraking).reduce((a, b) => a + b.distanceM, 0) / 1000;

  return (
    <div className="chart">
      <div className="chart__header">
        <h3>Grade distribution</h3>
      </div>
      <p className="field-group-note">
        <span className="grade-histogram__swatch grade-histogram__swatch--walk" /> walking (
        {walkKm.toFixed(1)} km) &nbsp;
        <span className="grade-histogram__swatch grade-histogram__swatch--brake" /> braking on descents (
        {brakeKm.toFixed(1)} km) &nbsp;
        <span className="grade-histogram__swatch grade-histogram__swatch--plain" /> running, limited by effort
      </p>
      <div className="chart__canvas" ref={containerRef}>
        {width > 0 && (
          <BarChart width={width} height={HEIGHT} data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <XAxis
              dataKey="gradePct"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`}
              label={{ value: "gradient", position: "insideBottomRight", offset: -4 }}
            />
            <YAxis
              tickFormatter={(v: number) => (v >= 1 ? v.toFixed(0) : v.toFixed(1))}
              label={{ value: "km", angle: -90, position: "insideLeft" }}
            />
            <Tooltip
              formatter={(_v, _n, entry) => {
                const b = entry?.payload as (typeof data)[number] | undefined;
                if (!b) return "";
                const tags = [b.hasWalking ? "walking" : null, b.hasBraking ? "braking" : null]
                  .filter(Boolean)
                  .join(", ");
                return [`${formatKm(b.distanceM)}, ${formatDuration(b.timeS)}${tags ? ` (${tags})` : ""}`, "in this bin"];
              }}
              labelFormatter={(v) => {
                const n = Number(v);
                return `${n > 0 ? "+" : ""}${n.toFixed(0)}% gradient`;
              }}
            />
            <Bar dataKey="distanceKm" isAnimationActive={false}>
              {data.map((b) => (
                <Cell
                  key={b.fromGradient}
                  // Walking wins the colour where both apply -- they can't
                  // in practice (walking is an uphill result, braking a
                  // descent one), but the precedence is stated rather than
                  // left to render order.
                  fill={b.hasWalking ? "#b45309" : b.hasBraking ? "#2d6a4f" : "var(--accent-border)"}
                />
              ))}
            </Bar>
          </BarChart>
        )}
      </div>
    </div>
  );
}
