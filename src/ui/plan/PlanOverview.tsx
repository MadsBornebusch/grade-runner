import { ArrowLeft, FlagCheckered, Path, Warning } from "@phosphor-icons/react";
import type { DatedHistoryRun } from "../../plan/historyFromRuns";
import type { Plan } from "../../plan/planGenerator";
import { PHASE_LABEL, formatMinutes, shortDate } from "./planCopy";
import { planWarnings, weekProgress } from "./planViewModel";

interface PlanOverviewProps {
  plan: Plan;
  raceName: string;
  raceDay: number;
  expectedHours: number;
  generic: boolean;
  history: DatedHistoryRun[];
  runNames: Map<string, string>;
  today: number;
  onBack: () => void;
  onOpenWeek: (start: number) => void;
  onEditSchedule: () => void;
}

export function PlanOverview({ plan, raceName, raceDay, expectedHours, generic, history, runNames, today, onBack, onOpenWeek, onEditSchedule }: PlanOverviewProps) {
  const raceLabel = (day: number) => {
    const run = history.find((r) => r.day === day && r.movingMin >= 60);
    return (run && runNames.get(run.runId)) || `your race on ${shortDate(day)}`;
  };
  const warnings = planWarnings(plan, expectedHours, generic, raceLabel);
  const best = [...plan.comparableRaces].sort((a, b) => b.chronicBefore - a.chronicBefore)[0];
  const scaleMax = Math.max(plan.projectedChronicAtRace, ...plan.comparableRaces.map((c) => c.chronicBefore)) * 1.15 || 1;

  return (
    <section className="plan-overview">
      <div className="screen-head">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to the week">
          <ArrowLeft size={20} />
        </button>
        <h2>
          Your plan to {raceName} · {shortDate(raceDay)}
        </h2>
      </div>

      <div className="card">
        <h3 className="card-title">Phases</h3>
        <div
          className="phase-strip"
          role="img"
          aria-label={plan.weeks.map((w) => PHASE_LABEL[w.phase]).join(", ")}
        >
          {plan.weeks.map((w) => (
            <button
              key={w.start}
              type="button"
              tabIndex={-1}
              className={`phase-strip__cell phase-${w.phase}${today >= w.start && today < w.start + 7 ? " phase-strip__cell--now" : ""}${w.start + 7 <= today ? "" : " phase-strip__cell--future"}`}
              title={`${shortDate(w.start)}: ${PHASE_LABEL[w.phase]}`}
              onClick={() => onOpenWeek(w.start)}
            />
          ))}
          <FlagCheckered size={18} weight="fill" className="phase-strip__flag" />
        </div>
        <ul className="phase-legend">
          {[...new Set(plan.weeks.map((w) => w.phase))].map((p) => (
            <li key={p}>
              <span className={`phase-dot phase-${p}`} /> {PHASE_LABEL[p]}
            </li>
          ))}
        </ul>
        <p className="help">Build weeks add about 5% a week. Every 4th build week is an easy week.</p>
        {plan.budgetBindsFrom !== null && <p className="help">From {shortDate(plan.budgetBindsFrom)} your hours are full: progress slows rather than adding time.</p>}
      </div>

      <div className="card">
        <h3 className="card-title">Race-day training</h3>
        {plan.comparableRaces.length === 0 ? (
          <p className="help">No past race of similar length to compare with.</p>
        ) : (
          <>
            <div className="readiness">
              <div className="readiness__bar" style={{ width: `${(100 * plan.projectedChronicAtRace) / scaleMax}%` }} />
              {plan.comparableRaces.map((c) => (
                <span key={c.day} className="readiness__tick" style={{ left: `${(100 * c.chronicBefore) / scaleMax}%` }} title={raceLabel(c.day)} />
              ))}
            </div>
            <p className="help">
              Bar: your training on race day if you follow the plan. Ticks: before{" "}
              {[...new Set(plan.comparableRaces.map((c) => raceLabel(c.day)))].join(", ")}.
            </p>
            {best && plan.projectedChronicAtRace >= best.chronicBefore && <p>About as trained as before {raceLabel(best.day)}, or more.</p>}
          </>
        )}
      </div>

      {warnings.map((w) => (
        <div key={w.text} className="banner banner--warning">
          <Warning size={20} weight="duotone" aria-hidden="true" />
          <div>
            <p>{w.text}</p>
            {w.action === "schedule" && (
              <button type="button" className="link-button" onClick={onEditSchedule}>
                Change your week
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="card table-card">
        <table className="week-table">
          <thead>
            <tr>
              <th>Week</th>
              <th>Phase</th>
              <th className="right">Hours</th>
              <th className="right">Long run</th>
            </tr>
          </thead>
          <tbody>
            {plan.weeks.map((w) => {
              const long = w.sessions.find((s) => s.kind === "long" || s.kind === "race");
              return (
                <tr key={w.start} onClick={() => onOpenWeek(w.start)} className={today >= w.start && today < w.start + 7 ? "week-table__now" : undefined}>
                  <td className="num">{shortDate(w.start)}</td>
                  <td>
                    <span className={`phase-dot phase-${w.phase}`} /> {PHASE_LABEL[w.phase]}
                  </td>
                  <td className="right num">
                    {(weekProgress(w, history, today).plannedMin / 60).toFixed(1)}
                    {w.budgetBinds && <span className="muted" title="Hours full"> ▪</span>}
                  </td>
                  <td className="right num">
                    {long ? (long.kind === "race" ? "Race" : formatMinutes(long.minutes)) : "–"}
                    {w.longRunWeek && long?.kind === "long" && <Path size={12} className="muted week-table__long" aria-label="long-run week" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
