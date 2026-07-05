import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  speedFromMs,
  speedToMs,
  suggestedFoPeakGPerMin,
  type FatOxPoint,
  type FormInputs,
  type WalkSpeedUnit,
} from "./formInputs";

interface FieldsProps {
  values: FormInputs;
  onChange: (values: FormInputs) => void;
}

/**
 * Buffers a numeric <input>'s text separately from the committed numeric
 * value. Without this, a fully-controlled `value={number}` input snaps back
 * to the last committed value (undoing the user's keystroke, including the
 * cursor position) the moment an edit passes through an invalid intermediate
 * state -- most commonly clearing the field to retype it, since "" parses to
 * NaN and gets rejected. We only push a change up once the typed text parses
 * to a real number, and only re-sync from the committed value when the field
 * isn't focused (so external changes, e.g. auto-fill, still show up).
 */
function useNumberField(value: number, onChange: (next: number) => void) {
  const [text, setText] = useState(() => String(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setText(String(value));
  }, [value]);

  return {
    value: text,
    onFocus: () => {
      editingRef.current = true;
    },
    onBlur: () => {
      editingRef.current = false;
      setText(String(value));
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value);
      const next = e.target.valueAsNumber;
      if (!Number.isNaN(next)) onChange(next);
    },
  };
}

interface FieldProps {
  label: string;
  hint?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}

function NumberField({ label, hint, value, step = 1, min, max, onChange }: FieldProps) {
  const field = useNumberField(value, onChange);
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input type="number" step={step} min={min} max={max} {...field} />
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

interface SpeedFieldProps {
  label: string;
  valueMs: number;
  unit: WalkSpeedUnit;
  onUnitChange: (unit: WalkSpeedUnit) => void;
  onChange: (ms: number) => void;
}

const MIN_WALK_SPEED_MS = 0.1;

function SpeedField({ label, valueMs, unit, onUnitChange, onChange }: SpeedFieldProps) {
  const displayValue = Math.round(speedFromMs(valueMs, unit) * 100) / 100;
  const field = useNumberField(displayValue, (next) => onChange(Math.max(MIN_WALK_SPEED_MS, speedToMs(next, unit))));
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input type="number" step={0.1} min={0} {...field} />
      <select
        className="field__unit-select"
        value={unit}
        onChange={(e) => onUnitChange(e.target.value as WalkSpeedUnit)}
        aria-label={`${label} unit`}
      >
        <option value="ms">m/s</option>
        <option value="kmh">km/h</option>
        <option value="minkm">min/km</option>
      </select>
    </label>
  );
}

interface FatOxRowProps {
  point: FatOxPoint;
  onChange: (patch: Partial<FatOxPoint>) => void;
  onRemove: () => void;
}

function FatOxRow({ point, onChange, onRemove }: FatOxRowProps) {
  const paceField = useNumberField(point.paceMinPerKm, (v) => onChange({ paceMinPerKm: v }));
  const fatField = useNumberField(point.fatGPerMin, (v) => onChange({ fatGPerMin: v }));
  const carbField = useNumberField(point.carbGPerMin, (v) => onChange({ carbGPerMin: v }));

  return (
    <div className="fatox-row">
      <input type="number" step={0.05} min={2} {...paceField} aria-label="Pace, minutes per km" />
      <span className="fatox-row__unit">min/km</span>
      <input type="number" step={0.01} min={0} {...fatField} aria-label="Fat oxidation, grams per minute" />
      <span className="fatox-row__unit">g/min fat</span>
      <input type="number" step={0.01} min={0} {...carbField} aria-label="Carb oxidation, grams per minute" />
      <span className="fatox-row__unit">g/min carb</span>
      <button type="button" className="fatox-row__remove" onClick={onRemove} aria-label="Remove point">
        &times;
      </button>
    </div>
  );
}

interface FatOxRowsProps {
  points: FatOxPoint[];
  onChange: (points: FatOxPoint[]) => void;
}

function FatOxRows({ points, onChange }: FatOxRowsProps) {
  const update = (i: number, patch: Partial<FatOxPoint>) =>
    onChange(points.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange(points.filter((_, idx) => idx !== i));
  const add = () => onChange([...points, { paceMinPerKm: 6, fatGPerMin: 0.4, carbGPerMin: 1.5 }]);

  return (
    <div className="fatox-rows">
      {points.map((p, i) => (
        <FatOxRow key={i} point={p} onChange={(patch) => update(i, patch)} onRemove={() => remove(i)} />
      ))}
      <button type="button" className="fatox-add" onClick={add}>
        + Add point
      </button>
    </div>
  );
}

/** Athlete physiology, fueling, pacing fade, and walk/run settings (Page 2). */
export function AthleteFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  const usingFatOxCurve = values.fatOxPoints.length > 0;

  return (
    <div className="inputs-panel">
      <fieldset>
        <legend>Athlete</legend>
        <p className="field-group-help">
          VO2max and LT1/LT2 set both your pace ceiling and (by default) how your energy split shifts from fat to
          carbs as effort increases. Don't know your VO2max? Fill in your fat oxidation curve below instead — it
          overrides LT1/LT2 for the fuel split, though VO2max still governs your pace ceiling.
        </p>
        <NumberField
          label="Body mass"
          hint="kg"
          value={values.bodyMassKg}
          step={0.5}
          min={30}
          onChange={(v) => set("bodyMassKg", v)}
        />
        <NumberField
          label="VO2max"
          hint="ml/kg/min"
          value={values.vo2MaxMlPerKgPerMin}
          step={1}
          min={20}
          onChange={(v) => set("vo2MaxMlPerKgPerMin", v)}
        />
        <NumberField
          label="LT1"
          hint="fraction of VO2max"
          value={values.lt1Fraction}
          step={0.01}
          min={0.1}
          max={0.95}
          onChange={(v) => set("lt1Fraction", v)}
        />
        <NumberField
          label="LT2"
          hint="fraction of VO2max"
          value={values.lt2Fraction}
          step={0.01}
          min={values.lt1Fraction + 0.01}
          max={0.99}
          onChange={(v) => set("lt2Fraction", v)}
        />
        {usingFatOxCurve && (
          <p className="field-group-note">LT1/LT2 are unused — your fat oxidation curve below is active instead.</p>
        )}
      </fieldset>

      <fieldset>
        <legend>Fat oxidation curve</legend>
        <p className="field-group-help">
          If you know your fat and carb oxidation rates at different paces (e.g. from a metabolic test), enter both
          here instead of relying on the default LT1/LT2 curve — the model needs both numbers to work out the fuel
          split at that pace. Add at least 2-3 points across a range of paces for a reliable fit — one point just
          shifts the default curve. Assumes the points were measured on flat ground.
        </p>
        <FatOxRows
          points={values.fatOxPoints}
          onChange={(fatOxPoints) => {
            const peak = suggestedFoPeakGPerMin(fatOxPoints);
            onChange({ ...values, fatOxPoints, ...(peak !== null ? { foPeakGPerMin: peak } : {}) });
          }}
        />
        <NumberField
          label="Fat oxidation peak"
          hint="g/min"
          value={values.foPeakGPerMin}
          step={0.05}
          min={0.1}
          onChange={(v) => set("foPeakGPerMin", v)}
        />
        {usingFatOxCurve && (
          <p className="field-group-note">
            Auto-filled from your highest measured fat-oxidation rate above — override if you know your true peak is
            higher (e.g. the test didn't reach it).
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Fueling</legend>
        <p className="field-group-help">
          Your fueling plan and body's carb tank. Glycogen store is what you're carrying at the start; the reserve
          floor is the level treated as "empty" (a bonk) — the model never simulates below it. Gut oxidation max caps
          how much of your carb intake actually gets absorbed; anything above it is wasted, not banked.
        </p>
        <NumberField
          label="Carb intake"
          hint="g/h"
          value={values.intakeGPerH}
          step={5}
          min={0}
          onChange={(v) => onChange({ ...values, intakeGPerH: v, gutMaxGPerH: v })}
        />
        <NumberField
          label="Gut oxidation max"
          hint="g/h"
          value={values.gutMaxGPerH}
          step={5}
          min={0}
          onChange={(v) => set("gutMaxGPerH", v)}
        />
        <NumberField
          label="Glycogen store"
          hint="g"
          value={values.glycogenStoreG}
          step={10}
          min={0}
          onChange={(v) => set("glycogenStoreG", v)}
        />
        <NumberField
          label="Reserve floor"
          hint="g, bonk threshold"
          value={values.reserveG}
          step={5}
          min={0}
          onChange={(v) => set("reserveG", v)}
        />
      </fieldset>

      <fieldset>
        <legend>Pacing curve</legend>
        <p className="field-group-help">
          How much of your aerobic max you can hold shrinks the longer you race — you can hold a high effort briefly,
          but only a much lower one all day. This curve models that fade: it starts near <strong>f0</strong> (the
          fraction of max you can hold at the start) and decays toward <strong>f_inf</strong> (the fraction you can
          sustain indefinitely), with <strong>tau</strong> controlling how many minutes that fade takes. The defaults
          are reasonable for most people — only change these if you know how you personally fade over a long race
          (e.g. from pacing data on a past ultra).
        </p>
        <NumberField
          label="f0"
          hint="starting sustainable fraction"
          value={values.f0}
          step={0.01}
          min={0.5}
          max={1}
          onChange={(v) => set("f0", v)}
        />
        <NumberField
          label="f_inf"
          hint="asymptotic sustainable fraction"
          value={values.fInf}
          step={0.01}
          min={0.1}
          max={0.9}
          onChange={(v) => set("fInf", v)}
        />
        <NumberField
          label="tau"
          hint="minutes, decay time constant"
          value={values.tauMin}
          step={10}
          min={10}
          onChange={(v) => set("tauMin", v)}
        />
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.durabilityDriftPerHour > 0}
            onChange={(e) => set("durabilityDriftPerHour", e.target.checked ? 0.01 : 0)}
          />
          <span>Durability drift</span>
        </label>
        <p className="field-group-help">
          Optional extra fade on top of the curve above, to model accumulated muscular fatigue (not just aerobic
          fade) over a very long day. Off by default — most people don't need this.
        </p>
        {values.durabilityDriftPerHour > 0 && (
          <NumberField
            label="Drift rate"
            hint="fraction lost per hour"
            value={values.durabilityDriftPerHour}
            step={0.001}
            min={0}
            max={0.1}
            onChange={(v) => set("durabilityDriftPerHour", v)}
          />
        )}
      </fieldset>

      <fieldset>
        <legend>Walk / run</legend>
        <p className="field-group-help">
          There's no fixed grade where everyone switches to walking — it falls out of the model naturally: running
          gets metabolically expensive on steep climbs, while walking is capped at a max speed. Once your target
          pace would need faster walking than that cap allows, running becomes faster and wins. Max walk speed sets
          that cap; force-walk overrides it for grades you know you'd never run anyway.
        </p>
        <SpeedField
          label="Max walk speed"
          valueMs={values.walkMaxMs}
          unit={values.walkSpeedDisplayUnit}
          onUnitChange={(unit) => set("walkSpeedDisplayUnit", unit)}
          onChange={(ms) => set("walkMaxMs", ms)}
        />
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.forceWalkAboveGrade !== null}
            onChange={(e) => set("forceWalkAboveGrade", e.target.checked ? 0.25 : null)}
          />
          <span>Force walk above grade</span>
        </label>
        {values.forceWalkAboveGrade !== null && (
          <NumberField
            label="Grade threshold"
            hint="fraction, e.g. 0.25 = 25%"
            value={values.forceWalkAboveGrade}
            step={0.01}
            min={0.05}
            max={0.5}
            onChange={(v) => set("forceWalkAboveGrade", v)}
          />
        )}
      </fieldset>
    </div>
  );
}

/** GPX processing settings: segment length, smoothing window, and the debug chart toggle (Page 1). */
export function CourseProcessingFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <div className="inputs-panel">
      <fieldset>
        <legend>Course processing</legend>
        <p className="field-group-help">
          How the raw GPS track gets cleaned up before the model uses it: elevation is smoothed and distance is
          resampled to fixed-length segments so noisy GPS points don't produce a jagged, unrealistic gradient. Fine
          to leave at the defaults unless your course has unusually sparse or noisy GPS data.
        </p>
        <NumberField
          label="Segment length"
          hint="m, resample spacing"
          value={values.segmentLengthM}
          step={5}
          min={5}
          onChange={(v) => set("segmentLengthM", v)}
        />
        <NumberField
          label="Smoothing window"
          hint="m, elevation smoothing"
          value={values.smoothingWindowM}
          step={5}
          min={5}
          onChange={(v) => set("smoothingWindowM", v)}
        />
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.altitudeAdjustment}
            onChange={(e) => set("altitudeAdjustment", e.target.checked)}
          />
          <span>Altitude adjustment</span>
        </label>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.showCourseDebug}
            onChange={(e) => set("showCourseDebug", e.target.checked)}
          />
          <span>Show raw-vs-processed debug chart</span>
        </label>
      </fieldset>
    </div>
  );
}
