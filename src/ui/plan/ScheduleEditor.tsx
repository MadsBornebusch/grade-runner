import { useState } from "react";
import { Lightbulb, Minus, Plus } from "@phosphor-icons/react";
import { slotsForWeek, suggestLongRunMaxMinutes } from "../../plan/planGenerator";
import type { ScheduleSettings } from "../../storage/planSettings";
import { WEEKDAY_LETTER, WEEKDAY_LONG, formatMinutes } from "./planCopy";

interface ScheduleEditorProps {
  schedule: ScheduleSettings;
  /** The race's expected hours, for the long-run suggestion; null before a
   * goal race is set. */
  expectedHours: number | null;
  onSave: (schedule: ScheduleSettings) => void;
  onCancel?: () => void;
  saveLabel?: string;
}

function Stepper({ value, onChange, step, min, max, label }: { value: number; onChange: (v: number) => void; step: number; min: number; max: number; label: string }) {
  return (
    <div className="stepper">
      <button type="button" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>
        <Minus size={20} weight="bold" />
      </button>
      <span className="stepper__value num" aria-live="polite">
        {formatMinutes(value)}
      </span>
      <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>
        <Plus size={20} weight="bold" />
      </button>
    </div>
  );
}

export function ScheduleEditor({ schedule, expectedHours, onSave, onCancel, saveLabel = "Save and re-plan" }: ScheduleEditorProps) {
  const [s, setS] = useState(schedule);
  const suggested = expectedHours ? suggestLongRunMaxMinutes(expectedHours, s.weeklyMinutes) : null;
  const longMax = Math.min(s.weeklyMinutes, s.longRunMaxMinutes ?? suggested ?? 150);
  const preview = slotsForWeek(
    { weeklyMinutes: s.weeklyMinutes, longRunWeekday: s.longRunWeekday, longRunMaxMinutes: longMax, runsPerWeek: s.runsPerWeek },
    0,
    false,
  ).slots.map((slot) => slot.weekday).sort((a, b) => a - b);
  const set = <K extends keyof ScheduleSettings>(k: K, v: ScheduleSettings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="schedule-editor">
      <div className="card sched-field">
        <span className="sched-field__label">Running time a week</span>
        <Stepper label="running time" value={s.weeklyMinutes} step={15} min={60} max={900} onChange={(v) => set("weeklyMinutes", v)} />
        <span className="help">Every week from now. Easy weeks and the taper use less.</span>
      </div>

      <div className="card sched-field">
        <span className="sched-field__label">Runs a week</span>
        <div className="choice-row" role="radiogroup" aria-label="Runs a week">
          {[2, 3, 4, 5, 6].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={s.runsPerWeek === n} className={s.runsPerWeek === n ? "choice choice--on" : "choice"} onClick={() => set("runsPerWeek", n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="card sched-field">
        <span className="sched-field__label">Long run day</span>
        <div className="day-picker" role="radiogroup" aria-label="Long run day">
          {WEEKDAY_LETTER.map((letter, wd) => (
            <button
              key={wd}
              type="button"
              role="radio"
              aria-checked={s.longRunWeekday === wd}
              aria-label={WEEKDAY_LONG[wd]}
              className={s.longRunWeekday === wd ? "day-picker__day day-picker__day--on" : "day-picker__day"}
              onClick={() => set("longRunWeekday", wd)}
            >
              {letter}
            </button>
          ))}
        </div>
        <span className="help">{WEEKDAY_LONG[s.longRunWeekday]}. You can move it in any week.</span>
      </div>

      <div className="card sched-field">
        <span className="sched-field__label">Longest long run</span>
        <Stepper label="long run" value={longMax} step={15} min={60} max={s.weeklyMinutes} onChange={(v) => set("longRunMaxMinutes", v)} />
        {suggested !== null && (
          <span className="help suggestion">
            <Lightbulb size={16} weight="fill" /> Suggested for your race: {formatMinutes(Math.min(suggested, s.weeklyMinutes))}
            {s.longRunMaxMinutes !== null && s.longRunMaxMinutes !== suggested && (
              <button type="button" className="link-button" onClick={() => set("longRunMaxMinutes", null)}>
                Use suggestion
              </button>
            )}
          </span>
        )}
      </div>

      <div className="card sched-field">
        <label className="switch-row">
          <input type="checkbox" checked={s.longRunWeekEvery === 2} onChange={(e) => set("longRunWeekEvery", e.target.checked ? 2 : 1)} />
          <span>
            <span className="sched-field__label">Long-run weeks</span>
            <span className="help">Every other week, a longer long run; the other runs get shorter to fit.</span>
          </span>
        </label>
      </div>

      <div className="card sched-field">
        <span className="sched-field__label">Strength</span>
        <div className="choice-row" role="radiogroup" aria-label="Strength sessions a week">
          {[0, 1, 2].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={s.strengthSessions === n} className={s.strengthSessions === n ? "choice choice--on" : "choice"} onClick={() => set("strengthSessions", n)}>
              {n === 0 ? "None" : `${n} a week`}
            </button>
          ))}
        </div>
        <label className="switch-row">
          <input type="checkbox" checked={s.strengthCountsInBudget} onChange={(e) => set("strengthCountsInBudget", e.target.checked)} />
          <span className="help">Count strength in my {formatMinutes(s.weeklyMinutes)}</span>
        </label>
      </div>

      <p className="help">Runs on: {preview.map((wd) => (wd === s.longRunWeekday ? `(${WEEKDAY_LONG[wd].slice(0, 3)})` : WEEKDAY_LONG[wd].slice(0, 3))).join(" ")}</p>

      <div className="sticky-actions">
        <button type="button" className="button-primary button-block" onClick={() => onSave(s)}>
          {saveLabel}
        </button>
        {onCancel && (
          <button type="button" className="button-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
