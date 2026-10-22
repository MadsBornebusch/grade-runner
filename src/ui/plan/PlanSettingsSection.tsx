import { planSettingsStore } from "../../storage/planSettings";
import type { FormInputs } from "../formInputs";
import type { PlanState } from "../usePlan";
import { planSnapshotStore } from "../usePlan";

/** Settings › Training plan: carbs, check-ins, re-plan and reset. The
 * weekly schedule itself is edited from Schedule › Your week. */
export function PlanSettingsSection({ plan, formInputs }: { plan: PlanState; formInputs: FormInputs }) {
  const settings = planSettingsStore.use();
  return (
    <section>
      <h3 className="section-title">Training plan</h3>
      <div className="card">
      <label className="form-row">
        <span>Long runs start at</span>
        <span className="input-unit">
          <input
            type="number"
            min={0}
            max={150}
            step={5}
            value={settings.carbsStartGPerH}
            onChange={(e) => planSettingsStore.set((s) => ({ ...s, carbsStartGPerH: Number(e.target.value) || 0 }))}
          />
          g/h
        </span>
      </label>
      <p className="help">Long runs of 90 min or more step up 5 g/h at a time toward your race's {formInputs.intakeGPerH} g/h (set under Goal race › Race fuelling). Once you log what you took, the steps start from what your stomach handled.</p>
      <label className="switch-row">
        <input type="checkbox" checked={settings.checkinsEnabled} onChange={(e) => planSettingsStore.set((s) => ({ ...s, checkinsEnabled: e.target.checked }))} />
        <span>Ask for sleep and morning HRV on Today</span>
      </label>
      <div className="sheet__actions">
        <button type="button" className="button-ghost" onClick={plan.replanNow} disabled={!plan.snapshot}>
          Re-plan now
        </button>
        <button
          type="button"
          className="button-ghost button-danger"
          onClick={() => {
            if (!window.confirm("Clear the goal race, your week and the plan? Runs and logs stay.")) return;
            planSettingsStore.set((s) => ({ ...s, goalRace: null, longRunMoves: {} }));
            planSnapshotStore.set({ version: 1, snapshot: null });
          }}
        >
          Reset plan
        </button>
      </div>
      </div>
    </section>
  );
}
