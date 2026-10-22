import { useMemo, useState } from "react";
import { useStrengthDone } from "../plan/useStrengthDone";
import { intensityTargets } from "../plan/intensity";
import { ArrowsClockwise, CaretRight, CheckCircle, FlagCheckered, Moon, XCircle } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { runsNeedingFuelLog } from "../../plan/carbLadder";
import { dateOfDayNumber, dayNumberOf } from "../../plan/historyFromRuns";
import { matchDay } from "../../plan/matchSessions";
import { mondayOf, type PlannedSession } from "../../plan/planGenerator";
import { fuelLogStore } from "../../storage/fuelLogs";
import { planSettingsStore } from "../../storage/planSettings";
import { getBackfillStatus, subscribeToBackfill } from "../backfillRuns";
import type { FormInputs } from "../formInputs";
import { CheckinCard } from "../plan/CheckinCard";
import { FuelLogCard } from "../plan/FuelLogCard";
import { PlanEmptyState } from "../plan/PlanEmptyState";
import { RestRow, SessionCard } from "../plan/SessionCard";
import { KIND_ICON } from "../plan/kindIcons";
import { SessionSheet } from "../plan/SessionSheet";
import { weekProgress } from "../plan/planViewModel";
import { KIND_TITLE, PHASE_LABEL, WEEKDAY_LETTER, dayLabel, dayName, formatMinutes, formatMinutesExact } from "../plan/planCopy";
import type { TabId } from "../useHashRoute";
import type { PlanState } from "../usePlan";

interface TodayTabProps {
  plan: PlanState;
  formInputs: FormInputs;
  navigate: (tab: TabId, ...rest: string[]) => void;
}

export function TodayTab({ plan, formInputs, navigate }: TodayTabProps) {
  const settings = planSettingsStore.use();
  const strengthDone = useStrengthDone(plan.snapshot);
  const logs = fuelLogStore.use().byRunId;
  const backfill = useSyncExternalStore(subscribeToBackfill, getBackfillStatus);
  const [openSession, setOpenSession] = useState<PlannedSession | null>(null);
  const race = settings.goalRace;
  const targets = useMemo(() => intensityTargets(formInputs, race?.raceEffortWPerKg), [formInputs, race?.raceEffortWPerKg]);
  const today = plan.today;
  const now = new Date();
  const header = (
    <header className="today-head">
      <div>
        <span className="overline">{now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>
        <h1 className="screen-title">Today</h1>
      </div>
      {backfill.running && (
        <span className="sync-line">
          <ArrowsClockwise size={14} className="spin" /> Syncing
        </span>
      )}
    </header>
  );
  const raceLine = race && dayNumberOf(race.date) >= today && (
    <button type="button" className="race-line" onClick={() => navigate("race")}>
      <FlagCheckered size={18} weight="duotone" />
      <span>
        {race.name} · <strong className="num">{countdown(dayNumberOf(race.date) - today)}</strong>
      </span>
      <CaretRight size={16} />
    </button>
  );

  const empty = <PlanEmptyState plan={plan} raceName={race?.name} navigate={navigate} />;
  if (plan.blocker || !plan.history || !plan.snapshot) {
    return (
      <>
        {header}
        {raceLine}
        <CheckinCard today={today} hour={now.getHours()} />
        {empty}
      </>
    );
  }

  const history = plan.history;
  const weeks = plan.snapshot.plan.weeks;
  const all = weeks.flatMap((w) => w.sessions);
  const week = weeks.find((w) => w.start === mondayOf(today));
  const todays = all.filter((s) => s.day === today).sort((a, b) => Number(a.kind === "strength") - Number(b.kind === "strength"));
  const match = matchDay(today, all, history, today);
  const runToday = todays.find((s) => s.kind !== "strength");
  const next = all.filter((s) => s.day > today && s.kind !== "strength").slice(0, 2);
  const yesterday = matchDay(today - 1, all, history, today);
  const loggable = history.map((r) => r);
  const fuelRuns = [
    ...runsNeedingFuelLog(loggable, logs, today),
    ...loggable.filter((r) => logs[r.runId]?.loggedOn === dateOfDayNumber(today) && !logs[r.runId].skipped),
  ].slice(0, 2);
  const targetOn = (day: number) => all.find((s) => s.day === day && s.carbsGPerH)?.carbsGPerH;

  return (
    <>
      {header}
      {raceLine}

      {todays.length === 0 ? (
        <div className="card hero-rest">
          <Moon size={28} weight="duotone" aria-hidden="true" />
          <div>
            <h2>Rest day</h2>
            <p>{next[0] ? `Nothing planned. Next: ${dayName(next[0].day)}, ${KIND_TITLE[next[0].kind].toLowerCase()} ${formatMinutes(next[0].minutes)}.` : "Nothing planned."}</p>
          </div>
        </div>
      ) : (
        todays.map((s) =>
          s.kind === "race" ? (
            <button key="race" type="button" className="race-hero race-hero--today" onClick={() => navigate("race")}>
              <span className="overline race-hero__date">Race day</span>
              <h2>{race?.name}</h2>
              <span>Good luck! See your race plan.</span>
            </button>
          ) : (
            <SessionCard
              key={s.kind}
              session={s}
              hero={s === runToday}
              targets={targets}
              state={s.kind === "strength" ? (strengthDone[dateOfDayNumber(today)] ? "done" : null) : match.state === "today" ? null : match.state}
              ranMin={match.runs.reduce((a, r) => a + r.movingMin, 0) || undefined}
              onOpen={() => setOpenSession(s)}
            />
          ),
        )
      )}

      <CheckinCard today={today} hour={now.getHours()} />
      {fuelRuns.map((r) => (
        <FuelLogCard key={r.runId} run={r} targetGPerH={targetOn(r.day)} today={today} />
      ))}

      {(yesterday.sessions.length > 0 || yesterday.runs.length > 0) && (
        <section>
          <h3 className="section-title">Yesterday</h3>
          <div className="card list-row">
            {yesterday.state === "skipped" ? <XCircle size={18} className="muted" /> : <CheckCircle size={18} weight="fill" className="success" />}
            <span className="num">
              {yesterday.sessions.map((s) => KIND_TITLE[s.kind]).join(" + ") || "Extra run"}
              {yesterday.runs.length > 0
                ? ` · ran ${formatMinutesExact(yesterday.runs.reduce((a, r) => a + r.movingMin, 0))}, ${yesterday.runs.reduce((a, r) => a + r.distanceKm, 0).toFixed(1)} km`
                : yesterday.state === "skipped"
                  ? " · missed"
                  : ""}
            </span>
          </div>
        </section>
      )}
      {yesterday.sessions.length === 0 && yesterday.runs.length === 0 && today - 1 >= mondayOf(today) && (
        <section>
          <h3 className="section-title">Yesterday</h3>
          <RestRow text="Rest day" />
        </section>
      )}

      {week && <WeekStrip plan={plan} weekStart={week.start} onOpen={() => navigate("schedule")} />}

      {next.length > 0 && (
        <section>
          <h3 className="section-title">Coming up</h3>
          <div className="card list">
            {next.map((s) => {
              const I = KIND_ICON[s.kind];
              return (
                <button key={s.day} type="button" className={`list-row kind-${s.kind}`} onClick={() => setOpenSession(s)}>
                  <I size={20} weight="duotone" className="kind-ink" />
                  <span>
                    {dayLabel(s.day)} · {KIND_TITLE[s.kind]} <span className="num muted">{s.kind === "race" ? "" : formatMinutes(s.minutes)}</span>
                  </span>
                  <CaretRight size={16} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {openSession && (
        <SessionSheet
          session={openSession}
          runs={openSession.kind === "strength" ? [] : history.filter((r) => r.day === openSession.day)}
          raceName={race?.name ?? "Race"}
          raceGPerH={formInputs.intakeGPerH}
          strengthCounts={settings.schedule.strengthCountsInBudget}
          targets={targets}
          strengthDone={strengthDone[dateOfDayNumber(openSession.day)] ?? null}
          onToggleStrength={() =>
            planSettingsStore.set((st) => {
              const key = dateOfDayNumber(openSession.day);
              const strengthDone = { ...st.strengthDone };
              if (strengthDone[key]) delete strengthDone[key];
              else strengthDone[key] = true;
              return { ...st, strengthDone };
            })
          }
          onClose={() => setOpenSession(null)}
        />
      )}
    </>
  );
}

function countdown(days: number): string {
  if (days === 0) return "today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} to go`;
  return `${Math.round(days / 7)} weeks to go`;
}

function WeekStrip({ plan, weekStart, onOpen }: { plan: PlanState; weekStart: number; onOpen: () => void }) {
  const week = plan.snapshot!.plan.weeks.find((w) => w.start === weekStart)!;
  const history = plan.history!;
  const { doneMin, plannedMin } = weekProgress(week, history, plan.today);
  return (
    <section>
      <button type="button" className="section-title section-title--link" onClick={onOpen}>
        This week · {PHASE_LABEL[week.phase]} <CaretRight size={14} />
      </button>
      <div className="card week-strip-card">
        <div className="week-strip">
          {Array.from({ length: 7 }, (_, i) => {
            const day = weekStart + i;
            const m = matchDay(day, week.sessions, history, plan.today);
            const kinds = m.sessions.map((s) => s.kind).slice(0, 2);
            return (
              <div key={i} className={`week-strip__day${day === plan.today ? " week-strip__day--today" : ""}${day < plan.today ? " week-strip__day--past" : ""}`}>
                <span className="week-strip__wd">{WEEKDAY_LETTER[i]}</span>
                <span className="week-strip__date num">{dateOfDayNumber(day).slice(8).replace(/^0/, "")}</span>
                <span className="week-strip__icons">
                  {m.runs.length > 0 ? (
                    <CheckCircle size={14} weight="fill" className="success" />
                  ) : kinds.length ? (
                    kinds.map((k) => {
                      const I = KIND_ICON[k];
                      return <I key={k} size={14} weight="fill" className={`kind-solid kind-${k}`} />;
                    })
                  ) : (
                    <span className="week-strip__rest" />
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="meter">
          <div className="meter__fill" style={{ width: `${plannedMin ? Math.min(100, (100 * doneMin) / plannedMin) : 0}%` }} />
        </div>
        <p className="help num">
          {formatMinutesExact(doneMin)} of {formatMinutes(plannedMin)} running done
        </p>
      </div>
    </section>
  );
}
