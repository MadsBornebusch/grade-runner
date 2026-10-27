import { CaretLeft, CaretRight, DotsThreeOutline, Path, PersonSimpleRun } from "@phosphor-icons/react";
import { sessionState, type SessionDone } from "./useSessionDone";
import type { IntensityTargets } from "./intensity";
import type { DatedHistoryRun } from "../../plan/historyFromRuns";
import { matchWeek } from "../../plan/matchSessions";
import type { PlannedSession, PlanWeek } from "../../plan/planGenerator";
import { DoneRunLine } from "./DoneRunLine";
import { RestRow, SessionCard } from "./SessionCard";
import { weekProgress } from "./planViewModel";
import { PHASE_EXPLAINER, PHASE_LABEL, dayLabel, formatMinutes, formatMinutesExact, shortDate } from "./planCopy";

interface WeekViewProps {
  week: PlanWeek;
  weekNumber: number;
  weekCount: number;
  history: DatedHistoryRun[];
  today: number;
  doneOf: SessionDone;
  targets: IntensityTargets;
  onOpen: (session: PlannedSession) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onMoveLongRun?: () => void;
  onEditSchedule: () => void;
  onAllWeeks: () => void;
}

export function WeekView({ week, weekNumber, weekCount, history, today, doneOf, targets, onOpen, onPrev, onNext, onMoveLongRun, onEditSchedule, onAllWeeks }: WeekViewProps) {
  const { doneMin, plannedMin, isCurrent } = weekProgress(week, history, today, (s) => !!doneOf(s));
  const isPast = week.start + 7 <= today;
  const days = matchWeek(week.start, week.sessions, history, today);
  const pct = plannedMin > 0 ? Math.min(100, (100 * doneMin) / plannedMin) : 0;
  const strengthMin = week.sessions.filter((s) => s.kind === "strength");
  return (
    <section className="week-view">
      <div className="week-nav">
        <button type="button" className="icon-button" onClick={onPrev} disabled={!onPrev} aria-label="Previous week">
          <CaretLeft size={20} />
        </button>
        <div className="week-nav__title">
          <span className="overline">{isCurrent ? "This week" : `Week ${weekNumber} of ${weekCount}`}</span>
          <h2>Week of {shortDate(week.start)}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onNext} disabled={!onNext} aria-label="Next week">
          <CaretRight size={20} />
        </button>
      </div>

      <div className="card week-head">
        <div className="chip-row">
          <span className={`phase-chip phase-${week.phase}`}>{PHASE_LABEL[week.phase]}</span>
          {week.longRunWeek && week.phase !== "taper" && week.phase !== "race" && (
            <span className="chip chip--long">
              <Path size={14} /> Long-run week
            </span>
          )}
          {week.budgetBinds && (
            <details className="hours-full">
              <summary className="chip chip--info">Hours full</summary>
              <p>
                This week would ideally have a bit more training than {formatMinutes(week.budgetMinutes)} holds. The plan doesn't add hours; it
                gets {Math.round((100 * week.plannedMechanical) / Math.max(1, week.targetMechanical))}% of the ideal step by making one run faster.
                You'll still improve, a bit more slowly.
              </p>
            </details>
          )}
        </div>
        <p className="week-head__explainer">
          {PHASE_EXPLAINER[week.phase]}
          {week.restUntil && ` No running or strength until ${dayLabel(week.restUntil)}: the days off are part of the plan.`}
          {week.sessions.some((s) => s.kind === "hike") && " A weighted hike builds your legs for the climbs."}
          {week.longRunWeek && week.phase !== "taper" && week.phase !== "race" && " Longer long run this week; the other runs are shorter to fit your hours."}
        </p>
        <div className="meter" role="img" aria-label={`${formatMinutesExact(doneMin)} of ${formatMinutes(plannedMin)} done`}>
          <div className="meter__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="week-head__totals num">
          {isCurrent || isPast ? (
            <span>
              <strong>{formatMinutesExact(doneMin)}</strong> of {formatMinutes(plannedMin)} done
            </span>
          ) : (
            <span>
              <strong>{formatMinutes(plannedMin)}</strong> planned
            </span>
          )}
          {strengthMin.length > 0 && (
            <span className="muted">
              + {strengthMin.length} × strength
            </span>
          )}
        </div>
        {!isCurrent && !isPast && <p className="help">May change as you train: the plan updates every Monday.</p>}
        <div className="week-head__actions">
          {onMoveLongRun && (
            <button type="button" className="button-ghost button-small" onClick={onMoveLongRun}>
              Move long run
            </button>
          )}
          <button type="button" className="button-ghost button-small" onClick={onEditSchedule}>
            <DotsThreeOutline size={16} /> Your week
          </button>
          <button type="button" className="button-ghost button-small" onClick={onAllWeeks}>
            All weeks
          </button>
        </div>
      </div>

      <ol className="day-list">
        {days.map((d) => {
          const isToday = d.day === today;
          const runMin = d.runs.reduce((s, r) => s + r.movingMin, 0);
          const empty = d.sessions.length === 0 && d.runs.length === 0;
          return (
            <li key={d.day} className={`day${d.day < today ? " day--past" : ""}`}>
              <div className="day__header">
                <span>{dayLabel(d.day)}</span>
                {isToday && <span className="today-pill">Today</span>}
              </div>
              {[...d.sessions].sort((a, b) => Number(a.kind === "strength") - Number(b.kind === "strength")).map((s) => (
                <SessionCard
                  key={s.kind}
                  session={s}
                  state={sessionState(s, d.state, doneOf)}
                  ranMin={s.kind === "strength" ? undefined : runMin || undefined}
                  targets={targets}
                  onOpen={() => onOpen(s)}
                />
              ))}
              {d.extra &&
                d.runs.map((r) => (
                  <div key={r.runId} className="extra-run">
                    <PersonSimpleRun size={18} weight="duotone" aria-hidden="true" />
                    <DoneRunLine run={r} className="extra-run__line" />
                  </div>
                ))}
              {empty && <RestRow text={week.restUntil && d.day < week.restUntil ? "Day off after the race" : d.day < today ? "Rest" : "Rest day"} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
