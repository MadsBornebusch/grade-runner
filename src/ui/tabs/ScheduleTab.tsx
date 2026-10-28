import { useMemo, useState } from "react";
import { toggleSessionDone, useSessionDone } from "../plan/useSessionDone";
import { intensityTargets } from "../plan/intensity";
import { dateOfDayNumber, dayNumberOf } from "../../plan/historyFromRuns";
import { mondayOf, type PlannedSession } from "../../plan/planGenerator";
import { expectedHoursOf, planSettingsStore } from "../../storage/planSettings";
import type { FormInputs } from "../formInputs";
import { MoveLongRunSheet } from "../plan/MoveLongRunSheet";
import { PlanEmptyState } from "../plan/PlanEmptyState";
import { PlanOverview } from "../plan/PlanOverview";
import { ProgressView } from "../plan/ProgressView";
import { ScheduleEditor } from "../plan/ScheduleEditor";
import { SessionSheet } from "../plan/SessionSheet";
import { WeekView } from "../plan/WeekView";
import { weekdayOf } from "../plan/planCopy";
import type { TabId } from "../useHashRoute";
import type { PlanState } from "../usePlan";

interface ScheduleTabProps {
  plan: PlanState;
  formInputs: FormInputs;
  rest: string[];
  navigate: (tab: TabId, ...rest: string[]) => void;
}

/** #/schedule (this week), #/schedule/week/YYYY-MM-DD, #/schedule/plan
 * (all weeks), #/schedule/edit (your week), #/schedule/progress. */
export function ScheduleTab({ plan, formInputs, rest, navigate }: ScheduleTabProps) {
  const settings = planSettingsStore.use();
  const doneOf = useSessionDone(plan.snapshot);
  const [openSession, setOpenSession] = useState<PlannedSession | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const race = settings.goalRace;
  const hours = race ? expectedHoursOf(race) : null;
  const targets = useMemo(() => intensityTargets(formInputs, race?.raceEffortWPerKg), [formInputs, race?.raceEffortWPerKg]);

  if (rest[0] === "edit") {
    return (
      <>
        <h1 className="screen-title">Your week</h1>
        <ScheduleEditor
          schedule={settings.schedule}
          expectedHours={hours}
          onSave={(schedule) => {
            planSettingsStore.set((s) => ({ ...s, schedule }));
            navigate("schedule");
          }}
          onCancel={() => navigate("schedule")}
        />
      </>
    );
  }

  if (rest[0] === "progress") {
    return plan.history ? (
      <ProgressView history={plan.history} today={plan.today} onBack={() => navigate("schedule")} />
    ) : (
      <p className="help">Loading your runs…</p>
    );
  }

  const empty = <PlanEmptyState plan={plan} raceName={race?.name} navigate={navigate} />;
  if (plan.blocker || !plan.history || !plan.snapshot) {
    return (
      <>
        <h1 className="screen-title">Schedule</h1>
        {empty}
        <button type="button" className="button-ghost" onClick={() => navigate("schedule", "edit")}>
          Set up your week
        </button>
      </>
    );
  }

  const { plan: p, generic } = plan.snapshot;
  const history = plan.history;
  if (p.status === "racePast" || p.weeks.length === 0) {
    return (
      <>
        <h1 className="screen-title">Schedule</h1>
        <div className="card empty-state">
          <h2>{race!.name} is done</h2>
          <p>How did it go? Pick your next race to get a new plan.</p>
          <button type="button" className="button-primary" onClick={() => navigate("race")}>
            Pick next race
          </button>
        </div>
      </>
    );
  }

  if (rest[0] === "plan") {
    return (
      <PlanOverview
        plan={p}
        raceName={race!.name}
        raceDay={dayNumberOf(race!.date)}
        expectedHours={hours!}
        generic={generic}
        history={history}
        runNames={plan.runNames}
        today={plan.today}
        onBack={() => navigate("schedule")}
        onOpenWeek={(start) => navigate("schedule", "week", dateOfDayNumber(start))}
        onEditSchedule={() => navigate("schedule", "edit")}
      />
    );
  }

  const wantStart = rest[0] === "week" && rest[1] ? mondayOf(dayNumberOf(rest[1])) : mondayOf(plan.today);
  const index = Math.max(0, p.weeks.findIndex((w) => w.start === wantStart));
  const week = p.weeks[index];
  const goWeek = (i: number) => navigate("schedule", ...(i === 0 ? [] : ["week", dateOfDayNumber(p.weeks[i].start)]));
  const longSession = week.sessions.find((s) => s.kind === "long");
  const canMove = !!longSession && week.start + 7 > plan.today;
  const moveLongRun = (weekday: number) => {
    planSettingsStore.set((s) => ({ ...s, longRunMoves: { ...s.longRunMoves, [dateOfDayNumber(week.start)]: weekday } }));
    setMoving(null);
    setOpenSession(null);
  };

  return (
    <>
      {p.status === "recovering" && (
        <div className="card empty-state">
          <h2>Recovering from {race!.name}</h2>
          <p>Days off, then easy running. Pick your next race when you're ready: its plan starts with what's left of this.</p>
          <button type="button" className="button-ghost" onClick={() => navigate("race")}>
            Pick next race
          </button>
        </div>
      )}
      <WeekView
        week={week}
        weekNumber={index + 1}
        weekCount={p.weeks.length}
        history={history}
        today={plan.today}
        doneOf={doneOf}
        targets={targets}
        onOpen={setOpenSession}
        onPrev={index > 0 ? () => goWeek(index - 1) : undefined}
        onNext={index < p.weeks.length - 1 ? () => goWeek(index + 1) : undefined}
        onMoveLongRun={canMove ? () => setMoving(weekdayOf(longSession!.day)) : undefined}
        onEditSchedule={() => navigate("schedule", "edit")}
        onAllWeeks={() => navigate("schedule", "plan")}
        onProgress={() => navigate("schedule", "progress")}
      />
      {openSession && (
        <SessionSheet
          session={openSession}
          runs={openSession.kind === "strength" ? [] : history.filter((r) => r.day === openSession.day)}
          raceName={race!.name}
          raceGPerH={formInputs.intakeGPerH}
          strengthCounts={settings.schedule.strengthCountsInBudget}
          targets={targets}
          bodyMassKg={formInputs.bodyMassKg}
          done={doneOf(openSession)}
          onToggleDone={() => toggleSessionDone(openSession)}
          onMoveLongRun={openSession.kind === "long" && canMove ? () => setMoving(weekdayOf(openSession.day)) : undefined}
          onClose={() => setOpenSession(null)}
        />
      )}
      {moving !== null && (
        <MoveLongRunSheet weekStart={week.start} currentWeekday={moving} today={plan.today} onMove={moveLongRun} onClose={() => setMoving(null)} />
      )}
    </>
  );
}
