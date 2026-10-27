import { Info } from "@phosphor-icons/react";
import { DoneRunLine } from "./DoneRunLine";
import type { StrengthDone } from "../../plan/strengthDone";
import type { DatedHistoryRun } from "../../plan/historyFromRuns";
import type { PlannedSession } from "../../plan/planGenerator";
import { GUARD_FLOORS, SESSION_GUARD_MULTIPLE } from "../../plan/sessionGuard";
import { Sheet } from "./Sheet";
import { KIND_TITLE, climbDescentText, dayLabel, distanceLine, effortDetail, formatMinutes, formatMinutesExact, howToRun } from "./planCopy";
import type { IntensityTargets } from "./intensity";
import { strengthWorkout } from "./strengthCopy";

interface SessionSheetProps {
  session: PlannedSession;
  runs: DatedHistoryRun[];
  raceName: string;
  raceGPerH: number;
  strengthCounts: boolean;
  targets: IntensityTargets;
  bodyMassKg?: number;
  /** Strength and hikes: done by hand or from Strava; null otherwise. */
  done: StrengthDone | null;
  onToggleDone: () => void;
  onMoveLongRun?: () => void;
  onClose: () => void;
}

export function SessionSheet({ session: s, runs, raceName, raceGPerH, strengthCounts, targets, bodyMassKg, done, onToggleDone, onMoveLongRun, onClose }: SessionSheetProps) {
  const isRun = s.kind !== "strength" && s.kind !== "race" && s.kind !== "hike";
  const ticked = s.kind === "strength" || s.kind === "hike";
  const ref = s.allowance;
  const effort = effortDetail(s, targets);
  return (
    <Sheet title={`${dayLabel(s.day)} · ${KIND_TITLE[s.kind]}`} onClose={onClose}>
      {s.kind !== "race" && (
        <div className="detail-hero">
          <span className="detail-hero__big num">{formatMinutes(s.minutes)}</span>
          {isRun && <span className="detail-hero__sub num">{distanceLine(s)}</span>}
        </div>
      )}
      {(isRun || s.kind === "hike") && (
        <dl className="facts">
          {effort && (
            <>
              <dt>Effort</dt>
              <dd className="num">
                {effort}
                {targets.easyMaxHr === null && (
                  <span className="facts__note">Add your LT1 heart rate in Settings, or lab stages with heart rate, for heart-rate targets.</span>
                )}
              </dd>
            </>
          )}
          {Math.max(s.descentM, s.climbM) >= 50 && (
            <>
              <dt>Hills</dt>
              <dd className="num">about {climbDescentText(s.climbM, s.descentM)}</dd>
            </>
          )}
          {s.steepDescentM >= 30 && (
            <>
              <dt>Steep</dt>
              <dd className="num">about {Math.round(s.steepDescentM / 10) * 10} m steeper than 17%</dd>
            </>
          )}
          {s.carbsGPerH ? (
            <>
              <dt>Carbs</dt>
              <dd className="num">
                {s.carbsGPerH} g/h · about {Math.round((s.carbsGPerH * s.minutes) / 60 / 5) * 5} g
                <span className="facts__note">
                  {s.carbsGPerH >= raceGPerH ? `Your race intake of ${raceGPerH} g/h.` : `Toward your race's ${raceGPerH} g/h, if your stomach agrees.`}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      )}

      {runs.length > 0 ? (
        <div className="done-block">
          <h3>Done</h3>
          {runs.map((r) => (
            <DoneRunLine key={r.runId} run={r} />
          ))}
        </div>
      ) : s.kind === "strength" ? (
        <StrengthBlock session={s} strengthCounts={strengthCounts} />
      ) : (
        <div className="how-block">
          <h3>{s.kind === "hike" ? "How to do it" : "How to run it"}</h3>
          <p>{howToRun(s, raceName, strengthCounts, targets, bodyMassKg)}</p>
        </div>
      )}

      {isRun && ref && (
        <details className="why-limit">
          <summary>
            <Info size={16} /> Why the limit?
          </summary>
          <p>
            {ref.movingMin <= GUARD_FLOORS.movingMin * SESSION_GUARD_MULTIPLE
              ? "A starting limit until you have a few weeks of longer runs."
              : `No run more than 10% beyond your biggest of the last 30 days (${formatMinutesExact(ref.movingMin / SESSION_GUARD_MULTIPLE)}, ${(ref.distanceKm / SESSION_GUARD_MULTIPLE).toFixed(0)} km).`}{" "}
            Today's limit: {formatMinutesExact(ref.movingMin)}, {Math.round(ref.distanceKm)} km, {Math.round(ref.climbM / 10) * 10} m up, {Math.round(ref.descentM / 10) * 10} m down. Small steps keep
            you injury-free.
          </p>
        </details>
      )}

      <div className="sheet__actions">
        {ticked && done?.source === "strava" && <p className="help">Done: {done.name}, from Strava.</p>}
        {ticked && done?.source !== "strava" && runs.length === 0 && (
          <button type="button" className={done ? "button-ghost" : "button-primary"} onClick={onToggleDone}>
            {done ? "Mark not done" : "Did it"}
          </button>
        )}
        {onMoveLongRun && (
          <button type="button" className="button-ghost" onClick={onMoveLongRun}>
            Move long run
          </button>
        )}
      </div>
    </Sheet>
  );
}

function StrengthBlock({ session, strengthCounts }: { session: PlannedSession; strengthCounts: boolean }) {
  const w = strengthWorkout(session.strengthFocus);
  return (
    <div className="how-block">
      <h3>{w.title}</h3>
      <p>{w.intro}</p>
      <ol className="exercise-list">
        {w.exercises.map((e) => (
          <li key={e.name}>
            <span className="exercise-list__name">{e.name}</span>
            <span className="exercise-list__dose num">{e.dose}</span>
            {e.note && <span className="exercise-list__note">{e.note}</span>}
          </li>
        ))}
      </ol>
      <p className="help">
        {w.rest} Short on time? Drop exercises from the bottom. {strengthCounts ? "Counted in your hours." : "Not counted in your running hours."}
      </p>
    </div>
  );
}
