import type { FormInputs } from "./formInputs";

interface InputsPanelProps {
  values: FormInputs;
  onChange: (values: FormInputs) => void;
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
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const next = e.target.valueAsNumber;
          if (!Number.isNaN(next)) onChange(next);
        }}
      />
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function InputsPanel({ values, onChange }: InputsPanelProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <div className="inputs-panel">
      <fieldset>
        <legend>Athlete</legend>
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
      </fieldset>

      <fieldset>
        <legend>Fueling</legend>
        <NumberField
          label="Carb intake"
          hint="g/h"
          value={values.intakeGPerH}
          step={5}
          min={0}
          onChange={(v) => set("intakeGPerH", v)}
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
        <NumberField
          label="Fat oxidation peak"
          hint="g/min"
          value={values.foPeakGPerMin}
          step={0.05}
          min={0.1}
          onChange={(v) => set("foPeakGPerMin", v)}
        />
      </fieldset>

      <fieldset>
        <legend>Pacing curve</legend>
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
        <NumberField
          label="Max walk speed"
          hint="m/s"
          value={values.walkMaxMs}
          step={0.1}
          min={0.5}
          onChange={(v) => set("walkMaxMs", v)}
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

      <fieldset>
        <legend>Course processing</legend>
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
      </fieldset>
    </div>
  );
}
