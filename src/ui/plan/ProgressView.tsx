// #/schedule/progress: training over time (from the run history, so it
// reaches back as far as the runs do) and the goal race's predicted finish
// (saved from when this page was added: storage/predictionLog.ts).
import { useMemo, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { dateOfDayNumber, dayNumberOf, type DatedHistoryRun } from "../../plan/historyFromRuns";
import { hikeHillRuns } from "../../plan/planFromSettings";
import { byMonth, loadSeries, longTermChange, weeklyTotals, type WeekTotals } from "../../plan/progressSeries";
import { planSettingsStore } from "../../storage/planSettings";
import { predictionLogStore, raceLogKey, type PredictionEntry } from "../../storage/predictionLog";
import { downsample } from "../downsample";
import { useContainerWidth } from "../useContainerWidth";
import { shortDate } from "./planCopy";

const RANGES = [
  { id: "3m", label: "3 mo", days: 91 },
  { id: "6m", label: "6 mo", days: 182 },
  { id: "1y", label: "1 yr", days: 365 },
  { id: "all", label: "All", days: Infinity },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const METRICS = [
  { id: "hours", label: "Hours", unit: "h", digits: 1 },
  { id: "km", label: "km", unit: "km", digits: 0 },
  { id: "climbM", label: "Climb", unit: "m", digits: 0 },
  { id: "descentM", label: "Descent", unit: "m", digits: 0 },
] as const;
type MetricId = (typeof METRICS)[number]["id"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (day: number, withYear: boolean) => {
  const [y, m] = dateOfDayNumber(day).split("-").map(Number);
  return withYear ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : MONTHS[m - 1];
};
const hm = (s: number) => {
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

interface ProgressViewProps {
  history: DatedHistoryRun[];
  today: number;
  onBack: () => void;
}

export function ProgressView({ history, today, onBack }: ProgressViewProps) {
  const settings = planSettingsStore.use();
  const [rangeId, setRangeId] = useState<RangeId>("6m");
  const [metric, setMetric] = useState<MetricId>("hours");
  const first = history.length ? Math.min(...history.map((r) => r.day)) : today;
  const range = RANGES.find((r) => r.id === rangeId)!;
  const from = Math.max(first, today - Math.min(range.days, today - first));
  const long = today - from > 400;

  const load = useMemo(() => loadSeries(history, today, from), [history, today, from]);
  // Over a month back, for the headline (independent of the range).
  const change = useMemo(() => longTermChange(loadSeries(history, today, today - 28), 28), [history, today]);
  const weeks = useMemo(() => {
    const n = Math.ceil((today - from + 1) / 7) + 1;
    const w = weeklyTotals(history, hikeHillRuns(settings), today, n);
    return long ? byMonth(w, (d) => dateOfDayNumber(d).slice(0, 7)) : w;
  }, [history, settings, today, from, long]);

  const race = settings.goalRace;
  const log = predictionLogStore.use().byRace;
  const predictions = race ? (log[raceLogKey(race)] ?? []) : [];

  return (
    <section className="progress">
      <div className="screen-head">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to the week">
          <ArrowLeft size={20} />
        </button>
        <h2>Progress</h2>
      </div>

      {race && <PredictionCard raceName={race.name} entries={predictions} today={today} ownTime={race.expectedHoursOverride !== null} />}

      <div className="segmented segmented--small progress__ranges" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={r.id === rangeId} className={r.id === rangeId ? "segmented__item segmented__item--active" : "segmented__item"} onClick={() => setRangeId(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      <LoadCard series={load} change={change} long={long} />
      <WeeksCard weeks={weeks} monthly={long} metric={metric} onMetric={setMetric} today={today} />
    </section>
  );
}

function PredictionCard({ raceName, entries, today, ownTime }: { raceName: string; entries: PredictionEntry[]; today: number; ownTime: boolean }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const last = entries.at(-1);
  const firstEntry = entries[0];
  const diff = last && firstEntry ? last.finishS - firstEntry.finishS : 0;
  // A step line, held to today: no entry means unchanged.
  const data = [...entries.map((e) => ({ day: dayNumberOf(e.date), finishS: e.finishS })), ...(last ? [{ day: today, finishS: last.finishS }] : [])];
  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">Predicted finish, {raceName}</h3>
      </div>
      {last ? (
        <>
          <p className="progress__headline">
            <span className="num progress__big">{hm(last.finishS)}</span>
            {Math.abs(diff) >= 60 && (
              <span className={diff < 0 ? "success" : "muted"}>
                {hm(Math.abs(diff)).replace(/^0:/, "")} {Math.abs(diff) < 3600 ? "min " : ""}
                {diff < 0 ? "faster" : "slower"} than on {shortDate(dayNumberOf(firstEntry.date))}
              </span>
            )}
          </p>
          {entries.length > 1 && (
            <div className="chart__canvas" ref={ref}>
              {width > 0 && (
                <LineChart width={width} height={160} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
                  <XAxis dataKey="day" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(d: number) => shortDate(d)} tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis dataKey="finishS" reversed domain={["dataMin - 300", "dataMax + 300"]} tickFormatter={hm} tick={{ fontSize: 11 }} width={44} />
                  <Tooltip formatter={(v) => [hm(Number(v)), "Predicted"]} labelFormatter={(d) => shortDate(Number(d))} />
                  <Line type="stepAfter" dataKey="finishS" stroke="var(--brand)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              )}
            </div>
          )}
          <p className="help">
            {entries.length > 1 ? "Faster is up. " : "Saved from now on: each new prediction is added here. "}
            It moves as the model learns from your runs, and when you change a setting it uses.
            {ownTime ? " Your plan uses your own expected time; this is the model's." : ""}
          </p>
        </>
      ) : (
        <p className="help">No prediction yet. Once the model predicts a finish for {raceName}, it's saved here each time it changes.</p>
      )}
    </div>
  );
}

function LoadCard({ series, change, long }: { series: ReturnType<typeof loadSeries>; change: number | null; long: boolean }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const now = series.at(-1);
  const data = downsample(series, 400);
  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">Training load</h3>
      </div>
      {now && (
        <p className="progress__headline">
          <span className="num progress__big">{Math.round(now.longTerm)}</span>
          <span className="muted">a week over 6 weeks</span>
          {change !== null && Math.abs(change) >= 0.02 && (
            <span className={change > 0 ? "success" : "muted"}>
              {change > 0 ? "↑" : "↓"} {Math.round(Math.abs(change) * 100)}% in 4 weeks
            </span>
          )}
        </p>
      )}
      <div className="chart__canvas" ref={ref}>
        {width > 0 && (
          <ComposedChart width={width} height={180} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
            <XAxis dataKey="day" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(d: number) => (long ? monthLabel(d, true) : shortDate(d))} tick={{ fontSize: 11 }} minTickGap={28} />
            <YAxis tick={{ fontSize: 11 }} width={36} />
            <Tooltip
              formatter={(v, name) => [Math.round(Number(v)), name === "longTerm" ? "6 weeks" : "Last 7 days"]}
              labelFormatter={(d) => shortDate(Number(d))}
            />
            <Area type="monotone" dataKey="longTerm" stroke="var(--brand)" strokeWidth={2} fill="var(--brand)" fillOpacity={0.15} isAnimationActive={false} />
            <Line type="monotone" dataKey="recent" stroke="var(--accent)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        )}
      </div>
      <p className="help">
        <span className="chart-swatch progress__swatch--long" />
        6-week average: your base, it builds slowly. <span className="chart-swatch progress__swatch--recent" />
        Last 7 days: how hard this week was. Load counts distance, with climbing and descent counting extra.
      </p>
    </div>
  );
}

function WeeksCard({ weeks, monthly, metric, onMetric, today }: { weeks: WeekTotals[]; monthly: boolean; metric: MetricId; onMetric: (m: MetricId) => void; today: number }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const m = METRICS.find((x) => x.id === metric)!;
  const fmt = (v: number) => (m.digits ? v.toFixed(m.digits) : Math.round(v).toLocaleString());
  const done = weeks.filter((w) => w.start + 7 <= today || monthly);
  const avg = done.length ? done.reduce((a, w) => a + w[metric], 0) / done.length : 0;
  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">{monthly ? "Per month" : "Per week"}</h3>
        <div className="segmented segmented--small" role="group" aria-label="Show">
          {METRICS.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === metric} className={x.id === metric ? "segmented__item segmented__item--active" : "segmented__item"} onClick={() => onMetric(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart__canvas" ref={ref}>
        {width > 0 && (
          <BarChart width={width} height={170} data={weeks} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
            <XAxis dataKey="start" tickFormatter={(d: number) => (monthly ? monthLabel(d, true) : shortDate(d))} tick={{ fontSize: 11 }} minTickGap={20} />
            <YAxis tick={{ fontSize: 11 }} width={40} />
            <Tooltip
              formatter={(v) => [`${fmt(Number(v))} ${m.unit}`, m.label]}
              labelFormatter={(d) => (monthly ? monthLabel(Number(d), true) : `Week of ${shortDate(Number(d))}`)}
              cursor={{ fill: "var(--surface-2)" }}
            />
            <Bar dataKey={metric} fill="var(--brand)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        )}
      </div>
      <p className="help num">
        Average {fmt(avg)} {m.unit} a {monthly ? "month" : "week"}
        {monthly ? "" : " (finished weeks)"}.{metric === "climbM" || metric === "descentM" ? " Includes hikes synced from Strava." : ""}
      </p>
    </div>
  );
}
