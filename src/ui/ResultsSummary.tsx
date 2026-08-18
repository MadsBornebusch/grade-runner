import type { CourseSummaryStats } from "./chartData";
import type { FlatPacedResult, SimulationResult } from "../model/solver";
import { formatDuration, formatPace } from "./format";

interface ResultsSummaryProps {
  theta: number;
  result: SimulationResult;
  totalDistanceM: number;
  /** findFlatPacedFinishTime with the athlete's own fitted pacing-margin
   * curve applied (pacingMarginFit.ts) -- null whenever that curve hasn't
   * been fit yet (needs a few user-confirmed races in Settings). Grounded
   * in this athlete's own recorded heart rate during past races, NOT the
   * theoretical zero-margin ceiling `result`/`theta` represent. */
  chosenPacing: FlatPacedResult | null;
  /** Same margin curve's own upper edge -- this athlete's best-demonstrated
   * execution relative to what the curve expects at a race of this length,
   * not a fantasy number. Still bounded by the theoretical ceiling. */
  bestDemonstrated: FlatPacedResult | null;
  /** Whole-course averages (pace, grade-adjusted pace, estimated heart
   * rate) for whichever plan is active (the target below when set, else
   * the theoretical ceiling) -- see chartData.ts's summarizeChartPoints. */
  summaryStats: CourseSummaryStats;
  /** User-chosen planned finish time, if set -- null means no target is
   * active. targetTimeS is what they asked for; result/theta is the
   * closest the solver could actually produce (may not match targetTimeS
   * exactly -- see the sublabel logic below). */
  target: { result: SimulationResult; theta: number; targetTimeS: number } | null;
}

function formatMinPerKm(minPerKm: number | null): string {
  return minPerKm === null ? "--:--/km" : formatPace(1000 / (minPerKm * 60));
}

function formatOrBonk(r: SimulationResult): string {
  return r.feasible ? formatDuration(r.finishTimeS) : "bonks";
}

const TARGET_MATCH_TOLERANCE_S = 60;

interface StatProps {
  label: string;
  value: string;
  sublabel: string;
  title: string;
  headline: boolean;
}

function Stat({ label, value, sublabel, title, headline }: StatProps) {
  return (
    <div className={`results-summary__stat${headline ? " results-summary__stat--headline" : ""}`} title={title}>
      <span className="results-summary__label">{label}</span>
      <span className="results-summary__value">{value}</span>
      <span className="results-summary__sublabel">{sublabel}</span>
    </div>
  );
}

export function ResultsSummary({
  theta,
  result,
  totalDistanceM,
  chosenPacing,
  bestDemonstrated,
  summaryStats,
  target,
}: ResultsSummaryProps) {
  const reachedKm = result.segments.length
    ? result.segments[result.segments.length - 1].cumulativeDistance3D / 1000
    : 0;
  const totalKm = totalDistanceM / 1000;

  const targetMatched = target && Math.abs(target.result.finishTimeS - target.targetTimeS) <= TARGET_MATCH_TOLERANCE_S;
  // Unreachable-fast target: the closest we can do (fastest feasible plan)
  // still finishes SLOWER than what was asked for.
  const targetTooFast = target && !targetMatched && target.result.finishTimeS > target.targetTimeS;

  // Lead with whatever's most useful to actually plan around: the athlete's
  // own explicit target when they've set one, else their fitted realistic
  // pacing (grounded in real race heart rate), else the theoretical
  // ceiling -- the only number available before any race history is fit,
  // and one nobody has ever actually run. Which stat is "first and biggest"
  // changes; its own meaning/tooltip never does.
  const headline: "target" | "chosen" | "ceiling" = target ? "target" : chosenPacing ? "chosen" : "ceiling";

  const ceilingStat = (
    <Stat
      key="ceiling"
      headline={headline === "ceiling"}
      label="Theoretical ceiling"
      value={formatOrBonk(result)}
      sublabel={`${(theta * 100).toFixed(0)}% effort — never actually achieved`}
      title="Theoretical upper bound, not a realistic target — you've never come within 15% of it, even on your best race."
    />
  );

  const targetStat = target && (
    <Stat
      key="target"
      headline={headline === "target"}
      label="Target"
      value={formatOrBonk(target.result)}
      sublabel={
        targetMatched
          ? `${(target.theta * 100).toFixed(0)}% effort`
          : targetTooFast
            ? "not achievable — showing fastest sustainable pace"
            : "closest achievable pace"
      }
      title={
        targetMatched
          ? "The pacing needed to hit your target finish time."
          : targetTooFast
            ? "Your target isn't reachable without bonking — this is your fastest sustainable pace instead."
            : "Your target is slower than this course's gentlest sustainable pace — this is the closest match."
      }
    />
  );

  const chosenStat = chosenPacing && (
    <Stat
      key="chosen"
      headline={headline === "chosen"}
      label="Chosen pacing"
      value={formatOrBonk(chosenPacing.result)}
      sublabel="from your own race history"
      title="What you'd likely run, based on your heart rate in past confirmed races."
    />
  );

  return (
    <div className={`results-summary ${result.feasible ? "results-summary--ok" : "results-summary--warn"}`}>
      {headline === "target" && targetStat}
      {headline === "chosen" && chosenStat}
      {headline === "ceiling" && ceilingStat}

      {headline !== "target" && targetStat}
      {headline !== "chosen" && chosenStat}
      {headline !== "ceiling" && ceilingStat}

      {bestDemonstrated && (
        <Stat
          headline={false}
          label="Best demonstrated"
          value={formatOrBonk(bestDemonstrated.result)}
          sublabel="your best day, this duration"
          title="What's possible if you execute like your best confirmed race, this length."
        />
      )}

      {(summaryStats.avgPaceMinPerKm !== null || summaryStats.avgHrBpm !== null) && (
        <div className="results-summary__averages">
          <span>Avg pace {formatMinPerKm(summaryStats.avgPaceMinPerKm)}</span>
          <span title="Grade-adjusted pace -- flat-equivalent pace for the same effort.">
            GAP {formatMinPerKm(summaryStats.avgGapMinPerKm)}
          </span>
          {summaryStats.avgHrBpm !== null && (
            <span title="Estimated from your HR-effort calibration, not measured.">
              Avg HR ~{Math.round(summaryStats.avgHrBpm)} bpm
            </span>
          )}
        </div>
      )}

      {chosenPacing && result.feasible && chosenPacing.result.feasible && (
        <p className="results-summary__margin-note">
          Margin: {formatDuration(chosenPacing.result.finishTimeS - result.finishTimeS)} slower than the theoretical
          ceiling.
          {bestDemonstrated?.result.feasible && chosenPacing.result.finishTimeS > bestDemonstrated.result.finishTimeS && (
            <> Room to improve on your typical pacing: {formatDuration(chosenPacing.result.finishTimeS - bestDemonstrated.result.finishTimeS)}.</>
          )}
        </p>
      )}

      {!result.feasible && (
        <p className="results-summary__warning">
          Bonk predicted at {reachedKm.toFixed(1)} km of {totalKm.toFixed(1)} km — increase fueling,
          slow down, or carry more glycogen reserve.
        </p>
      )}
    </div>
  );
}
