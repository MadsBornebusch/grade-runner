import { useState } from "react";
import { CheckCircle, ForkKnife } from "@phosphor-icons/react";
import { fuelPresets } from "../../plan/carbLadder";
import { dateOfDayNumber, type DatedHistoryRun } from "../../plan/historyFromRuns";
import { fuelLogStore, type FuelLog } from "../../storage/fuelLogs";
import { dayName, formatMinutesExact } from "./planCopy";

const STOMACH = ["Fine", "A bit off", "Bad", "Had to stop"] as const;

/** "How many carbs did you take?" after a synced long run: one tap on a
 * preset around the session's target, then an optional stomach answer. */
export function FuelLogCard({ run, targetGPerH, today }: { run: DatedHistoryRun; targetGPerH?: number; today: number }) {
  const log = fuelLogStore.use().byRunId[run.runId];
  const [other, setOther] = useState<string | null>(null);
  const [asTotal, setAsTotal] = useState(false);
  const save = (entry: Partial<FuelLog>) =>
    fuelLogStore.set((s) => ({
      ...s,
      byRunId: { ...s.byRunId, [run.runId]: { ...(s.byRunId[run.runId] ?? { enteredAs: "gPerH", loggedOn: dateOfDayNumber(today) }), ...entry } },
    }));
  const undo = () =>
    fuelLogStore.set((s) => {
      const byRunId = { ...s.byRunId };
      delete byRunId[run.runId];
      return { ...s, byRunId };
    });
  const hours = run.movingMin / 60;

  return (
    <div className="card fuel-log">
      <h3 className="card-title">
        <ForkKnife size={20} weight="duotone" /> {dayName(run.day)} run · {formatMinutesExact(run.movingMin)} · {run.distanceKm.toFixed(0)} km
      </h3>
      {!log ? (
        <>
          <p>How many carbs did you take? (g per hour)</p>
          <div className="choice-row choice-row--wrap">
            {fuelPresets(targetGPerH).map((g) => (
              <button key={g} type="button" className={g === targetGPerH ? "choice choice--target" : "choice"} onClick={() => save({ gPerH: g })}>
                {g}
                {g === targetGPerH && <span className="choice__tag">target</span>}
              </button>
            ))}
            <button type="button" className="choice" onClick={() => save({ gPerH: 0 })}>
              None
            </button>
          </div>
          {other === null ? (
            <div className="fuel-log__links">
              <button type="button" className="link-button" onClick={() => setOther("")}>
                Other…
              </button>
              <button type="button" className="link-button" onClick={() => save({ skipped: true })}>
                Skip
              </button>
            </div>
          ) : (
            <form
              className="fuel-log__other"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(other);
                if (!(n >= 0)) return;
                save(asTotal ? { gPerH: Math.round(n / hours), enteredAs: "totalG" } : { gPerH: Math.round(n) });
              }}
            >
              <input type="number" inputMode="numeric" autoFocus value={other} onChange={(e) => setOther(e.target.value)} aria-label={asTotal ? "Total grams" : "Grams per hour"} />
              <div className="segmented segmented--small">
                <button type="button" className={!asTotal ? "segmented__item segmented__item--active" : "segmented__item"} onClick={() => setAsTotal(false)}>
                  g/h
                </button>
                <button type="button" className={asTotal ? "segmented__item segmented__item--active" : "segmented__item"} onClick={() => setAsTotal(true)}>
                  total g
                </button>
              </div>
              <button type="submit" className="button-primary button-small">
                Save
              </button>
            </form>
          )}
        </>
      ) : log.skipped ? null : (
        <>
          <p className="num">
            <CheckCircle size={18} weight="fill" className="success" /> Saved: {log.gPerH} g/h · about {Math.round(((log.gPerH ?? 0) * hours) / 5) * 5} g{" "}
            <button type="button" className="link-button" onClick={undo}>
              Undo
            </button>
          </p>
          {log.gi === undefined && (log.gPerH ?? 0) > 0 && (
            <>
              <p>Stomach?</p>
              <div className="choice-row choice-row--wrap">
                {STOMACH.map((label, gi) => (
                  <button key={label} type="button" className="choice" onClick={() => save({ gi: gi as FuelLog["gi"] })}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          {log.gi !== undefined && <p className="help">Stomach: {STOMACH[log.gi].toLowerCase()}. Your next long runs build from this.</p>}
        </>
      )}
    </div>
  );
}
