// #/<tab>/progress (App.tsx): training over time from the run history, so
// it reaches back as far as the runs do, with the plan ahead; the goal
// race's predicted finish (saved from when this page was added:
// storage/predictionLog.ts); and the experimental fitness index
// (plan/fitnessIndex.ts). Solid numbers first, the experimental chart last.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceArea, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { costOfRunning } from "../../model/minetti";
import { grossToNet } from "../../model/energetics";
import { buildFitnessSummaries } from "../../plan/fitnessFromRuns";
import { fitnessReadings, trailingIndex, type CompactRunSummary } from "../../plan/fitnessIndex";
import { listStoredRuns } from "../../storage/runLibrary";
import { resolveCeilingParams, type FormInputs } from "../formInputs";
import { dateOfDayNumber, dayNumberOf, type DatedHistoryRun } from "../../plan/historyFromRuns";
import { hikeHillRuns } from "../../plan/planFromSettings";
import { mondayOf, type Phase, type Plan } from "../../plan/planGenerator";
import { byMonth, loadSeries, longTermChange, phaseBands, planProjection, weeklyTotals, type LoadPoint, type PhaseBand, type WeekTotals } from "../../plan/progressSeries";
import { phaseLogStore } from "../../storage/phaseLog";
import { planSettingsStore } from "../../storage/planSettings";
import { predictionLogStore, raceLogKey, type PredictionEntry } from "../../storage/predictionLog";
import { downsample } from "../downsample";
import { useContainerWidth } from "../useContainerWidth";
import type { PlanState } from "../usePlan";
import { PHASE_LABEL, shortDate } from "./planCopy";
import { loadTrend, modelFinishLabel, predictionDelta } from "./progressCopy";
import { pastRaceLabel } from "./planViewModel";
import { ReadinessCard } from "./ReadinessCard";

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
  plan: PlanState;
  formInputs: FormInputs;
  onBack: () => void;
}

export function ProgressView({ plan, formInputs, onBack }: ProgressViewProps) {
  return (
    <section className="progress">
      <div className="screen-head">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h2>Progress</h2>
      </div>
      {plan.history ? <ProgressCards plan={plan} history={plan.history} formInputs={formInputs} /> : <p className="help">Loading your runs…</p>}
    </section>
  );
}

function ProgressCards({ plan, history, formInputs }: { plan: PlanState; history: DatedHistoryRun[]; formInputs: FormInputs }) {
  const settings = planSettingsStore.use();
  const phaseLog = phaseLogStore.use().byWeek;
  const [rangeId, setRangeId] = useState<RangeId>("6m");
  const [metric, setMetric] = useState<MetricId>("hours");
  const today = plan.today;
  const first = history.length ? Math.min(...history.map((r) => r.day)) : today;
  const range = RANGES.find((r) => r.id === rangeId)!;
  const from = Math.max(first, today - Math.min(range.days, today - first));
  const long = today - from > 400;
  const p: Plan | null = plan.snapshot?.plan ?? null;
  const phase = p?.weeks.find((w) => w.start === mondayOf(today))?.phase;

  const load = useMemo(() => loadSeries(history, today, from), [history, today, from]);
  // Over a month back, for the headline (independent of the range).
  const change = useMemo(() => longTermChange(loadSeries(history, today, today - 28), 28), [history, today]);
  const weeks = useMemo(() => {
    const n = Math.ceil((today - from + 1) / 7) + 1;
    const w = weeklyTotals(history, hikeHillRuns(settings), today, n);
    return long ? byMonth(w, (d) => dateOfDayNumber(d).slice(0, 7)) : w;
  }, [history, settings, today, from, long]);

  // The plan ahead, up to half the range past today (all of it on All).
  const race = settings.goalRace;
  const raceDay = race ? dayNumberOf(race.date) : undefined;
  const to = p && p.status === "ok" && raceDay ? Math.min(raceDay, range.days === Infinity ? raceDay : today + Math.max(28, Math.round(range.days / 2))) : today;
  const ahead = useMemo(
    () =>
      p && load.length
        ? planProjection(p.weeks, today, load.at(-1)!.longTerm, raceDay && p.status === "ok" ? { day: raceDay, chronic: p.projectedChronicAtRace } : undefined).filter((x) => x.day <= to)
        : [],
    [p, load, today, raceDay, to],
  );
  const bands = useMemo(
    () => phaseBands(new Map(Object.entries(phaseLog).map(([d, ph]) => [dayNumberOf(d), ph])), p?.weeks ?? [], from, Math.max(today + 1, to)),
    [phaseLog, p, from, today, to],
  );

  const log = predictionLogStore.use().byRace;
  const predictions = race ? (log[raceLogKey(race)] ?? []) : [];
  const finishLabel = modelFinishLabel(!!formInputs.pacingMargin);

  return (
    <>
      <div className="segmented segmented--small progress__ranges" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={r.id === rangeId} className={r.id === rangeId ? "segmented__item segmented__item--active" : "segmented__item"} onClick={() => setRangeId(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      <LoadCard series={load} ahead={ahead} bands={bands} change={change} phase={phase} long={long} raceDay={raceDay !== undefined && raceDay <= to ? raceDay : undefined} />
      {p && p.status === "ok" && <ReadinessCard plan={p} raceLabel={pastRaceLabel(history, plan.runNames)} />}
      <WeeksCard weeks={weeks} monthly={long} metric={metric} onMetric={setMetric} today={today} />
      {race && <PredictionCard raceName={race.name} label={finishLabel} entries={predictions} today={today} ownTime={race.expectedHoursOverride !== null} />}
      <FitnessCard history={history} formInputs={formInputs} from={from} long={long} />
    </>
  );
}

function PredictionCard({ raceName, label, entries, today, ownTime }: { raceName: string; label: string; entries: PredictionEntry[]; today: number; ownTime: boolean }) {
  const last = entries.at(-1);
  const delta = predictionDelta(entries);
  // One entry: a line, not a tall card with no chart.
  if (entries.length < 2) {
    return (
      <div className="card progress-note">
        <p>
          <strong>
            {label}, {raceName}
            {last ? `: ${hm(last.finishS)}` : ""}
          </strong>
        </p>
        <p className="help">
          {last ? `Saved since ${shortDate(dayNumberOf(entries[0].date))}. A chart appears here once it changes.` : "No prediction yet."}
          {ownTime ? " Your plan uses your own expected time; this is the model's." : ""}
        </p>
      </div>
    );
  }
  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">
          {label}, {raceName}
        </h3>
      </div>
      <p className="progress__headline">
        <span className="num progress__big">{hm(last!.finishS)}</span>
        {delta && <span className={delta.faster ? "success" : "muted"}>{delta.text}</span>}
      </p>
      <PredictionChart entries={entries} today={today} />
      <p className="help">
        Faster is up. It moves as the model learns from your runs, and when you change a setting it uses.
        {ownTime ? " Your plan uses your own expected time; this is the model's." : ""}
      </p>
    </div>
  );
}

function PredictionChart({ entries, today }: { entries: PredictionEntry[]; today: number }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  // A step line, held to today: no entry means unchanged.
  const data = [...entries.map((e) => ({ day: dayNumberOf(e.date), finishS: e.finishS })), { day: today, finishS: entries.at(-1)!.finishS }];
  return (
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
  );
}

interface LoadCardProps {
  series: LoadPoint[];
  ahead: { day: number; plan: number }[];
  bands: PhaseBand[];
  change: number | null;
  phase?: Phase;
  long: boolean;
  raceDay?: number;
}

function LoadCard({ series, ahead, bands, change, phase, long, raceDay }: LoadCardProps) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const now = series.at(-1);
  const trend = loadTrend(change, phase);
  const data = [...downsample(series, 400), ...ahead.slice(1)].map((d) => d as Partial<LoadPoint> & { day: number; plan?: number });
  if (ahead.length && data.length > ahead.length - 1) data[data.length - ahead.length] = { ...data[data.length - ahead.length], plan: ahead[0].plan };
  const phases = [...new Set(bands.map((b) => b.phase))];
  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">Training load</h3>
      </div>
      {now && (
        <p className="progress__headline">
          <span className="num progress__big">{Math.round(now.longTerm)}</span>
          <span className="muted">a week over 6 weeks</span>
          {trend && <span className={trend.tone === "up" ? "success" : "muted"}>{trend.text}</span>}
        </p>
      )}
      <div className="chart__canvas" ref={ref}>
        {width > 0 && (
          <ComposedChart width={width} height={190} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            {bands.map((b) => (
              <ReferenceArea key={b.from} x1={b.from} x2={b.to} fill={`var(--phase-${b.phase})`} fillOpacity={0.12} stroke="none" ifOverflow="hidden" />
            ))}
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
            <XAxis dataKey="day" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(d: number) => (long ? monthLabel(d, true) : shortDate(d))} tick={{ fontSize: 11 }} minTickGap={28} />
            <YAxis tick={{ fontSize: 11 }} width={36} />
            <Tooltip
              formatter={(v, name) => [Math.round(Number(v)), name === "longTerm" ? "6 weeks" : name === "plan" ? "6 weeks, planned" : "Last 7 days"]}
              labelFormatter={(d) => shortDate(Number(d))}
            />
            <Area type="monotone" dataKey="longTerm" stroke="var(--brand)" strokeWidth={2} fill="var(--brand)" fillOpacity={0.15} isAnimationActive={false} />
            <Line type="monotone" dataKey="recent" stroke="var(--accent)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {ahead.length > 1 && <Line type="monotone" dataKey="plan" stroke="var(--brand)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />}
            {raceDay !== undefined && <ReferenceArea x1={raceDay - 0.5} x2={raceDay + 0.5} fill="var(--phase-race)" fillOpacity={0.6} stroke="none" ifOverflow="hidden" />}
          </ComposedChart>
        )}
      </div>
      <p className="help">
        <span className="chart-swatch progress__swatch--long" />
        6-week average: your base, it builds slowly. <span className="chart-swatch progress__swatch--recent" />
        Last 7 days: how hard this week was.{ahead.length > 1 ? " Dashed: where the plan takes you." : ""} Load counts distance, with climbing and descent counting extra.
      </p>
      {phases.length > 0 && (
        <ul className="phase-legend">
          {phases.map((ph) => (
            <li key={ph}>
              <span className={`phase-dot phase-${ph}`} /> {PHASE_LABEL[ph]}
            </li>
          ))}
        </ul>
      )}
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

/** Flat-ground pace, s/km, for a gross power (W/kg). */
const flatPaceS = (grossWPerKg: number) => 1000 / (grossToNet(grossWPerKg) / costOfRunning(0));
const paceText = (sPerKm: number) => `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, "0")}`;

/** Per-run index summaries, by run id; computed once per run and cached. */
function useFitnessSummaries(formInputs: FormInputs) {
  const [state, setState] = useState<{ summaries: Map<string, CompactRunSummary> | null; progress: { done: number; total: number } | null }>({ summaries: null, progress: null });
  const bodyMassKg = formInputs.bodyMassKg;
  useEffect(() => {
    let cancelled = false;
    const ceiling = resolveCeilingParams(formInputs);
    listStoredRuns()
      .then((runs) => buildFitnessSummaries(runs, bodyMassKg, ceiling, (done, total) => !cancelled && setState((s) => ({ ...s, progress: { done, total } })), () => cancelled))
      .then((summaries) => !cancelled && summaries && setState({ summaries, progress: null }))
      .catch(() => !cancelled && setState({ summaries: new Map(), progress: null }));
    return () => {
      cancelled = true;
    };
    // Pace-derived power is per kg and doesn't use the ceiling; the mass is
    // only there for analyzeRun's bookkeeping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

function FitnessCard({ history, formInputs, from, long }: { history: DatedHistoryRun[]; formInputs: FormInputs; from: number; long: boolean }) {
  const { summaries, progress } = useFitnessSummaries(formInputs);
  const fit = useMemo(() => {
    if (!summaries) return null;
    const runs = history.flatMap((r) => (summaries.has(r.runId) ? [{ day: r.day, summary: summaries.get(r.runId)! }] : []));
    return fitnessReadings(runs);
  }, [summaries, history]);
  const trend = useMemo(() => (fit ? trailingIndex(fit.readings) : []), [fit]);

  const runs = (fit?.readings ?? []).filter((r) => r.day >= from).map((r) => ({ day: r.day, run: flatPaceS(r.value) }));
  const line = trend.filter((r) => r.day >= from).map((r) => ({ day: r.day, avg: flatPaceS(r.value) }));
  const now = trend.at(-1);
  // The same average about 3 months earlier, for the headline.
  const then = now && [...trend].reverse().find((r) => r.day <= now.day - 84 && r.day > now.day - 130);
  const diffS = now && then ? flatPaceS(now.value) - flatPaceS(then.value) : null;

  return (
    <div className="card chart">
      <div className="chart__header">
        <h3 className="card-title">Fitness</h3>
        <span className="chip chip--info">Experimental</span>
      </div>
      {!fit ? (
        <p className="help num">{progress ? `Reading your runs' heart rate… ${progress.done} of ${progress.total}` : "Reading your runs' heart rate…"}</p>
      ) : fit.readings.length < 3 ? (
        <p className="help">Not enough runs with heart rate and flat running yet.</p>
      ) : (
        <>
          {now && (
            <p className="progress__headline">
              <span className="num progress__big">{paceText(flatPaceS(now.value))}</span>
              <span className="muted num">/km on the flat at {fit.referenceHr} bpm</span>
              {diffS !== null && Math.abs(diffS) >= 2 && (
                <span className={diffS < 0 ? "success num" : "muted num"}>
                  {Math.round(Math.abs(diffS))} s/km {diffS < 0 ? "faster" : "slower"} than 3 months ago
                </span>
              )}
            </p>
          )}
          {runs.length > 0 ? (
            <FitnessChart runs={runs} line={line} from={from} long={long} />
          ) : (
            <p className="help">No runs in this range give a reading.</p>
          )}
          <p className="help">
            Your pace on flat ground at {fit.referenceHr} bpm, from runs with full data, heart rate and at least 8 minutes of flat running ({fit.readings.length} runs so far). Each dot is a run, the line the 6-week average; faster is up.
            Experimental: averaged over a few weeks it's steady enough to show changes of a few percent, but it hasn't yet been shown to follow race fitness, and hilly or very long runs read a little slower.
          </p>
        </>
      )}
    </div>
  );
}

function FitnessChart({ runs, line, from, long }: { runs: { day: number; run: number }[]; line: { day: number; avg: number }[]; from: number; long: boolean }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const all = [...runs.map((r) => r.run), ...line.map((r) => r.avg)];
  // Ticks on whole half minutes.
  const lo = Math.floor(Math.min(...all) / 30) * 30;
  const hi = Math.ceil(Math.max(...all) / 30) * 30;
  const step = hi - lo > 150 ? 60 : 30;
  const ticks = Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const start = Math.max(from, runs[0].day - 7);
  return (
    <div className="chart__canvas" ref={ref}>
      {width > 0 && (
        <ComposedChart width={width} height={180} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
          <XAxis dataKey="day" type="number" domain={[start, "dataMax"]} tickFormatter={(d: number) => (long && runs.at(-1)!.day - start > 400 ? monthLabel(d, true) : shortDate(d))} tick={{ fontSize: 11 }} minTickGap={28} allowDuplicatedCategory={false} />
          <YAxis type="number" reversed domain={[lo, hi]} ticks={ticks} tickFormatter={paceText} tick={{ fontSize: 11 }} width={40} />
          <Tooltip formatter={(v, name) => [`${paceText(Number(v))} /km`, name === "avg" ? "6-week average" : "Run"]} labelFormatter={(d) => shortDate(Number(d))} />
          <Scatter data={runs} dataKey="run" fill="var(--text-faint)" fillOpacity={0.5} shape="circle" isAnimationActive={false} />
          <Line data={line} type="monotone" dataKey="avg" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      )}
    </div>
  );
}
