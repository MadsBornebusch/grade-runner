import { useMemo } from "react";
import { useNumberField } from "./useNumberField";
import {
  displayToPaceMinPerKm,
  equivalentLT1LT2,
  paceMinPerKmToDisplay,
  paceToVo2MaxFraction,
  rateFromGPerMin,
  rateToGPerMin,
  resolveGlycogenStoreG,
  resolveLt1Lt2Fractions,
  resolveVo2Max,
  speedFromMs,
  speedToMs,
  suggestedFoPeakGPerMin,
  type FatOxPoint,
  type FatOxRateUnit,
  type FormInputs,
  type Vo2MaxEntry,
  type Vo2MaxSource,
  type WalkSpeedUnit,
} from "./formInputs";
import { FatOxCurveChart } from "./FatOxCurveChart";
import { generateTheoreticalFatOxCurve } from "../model/substrate";

interface FieldsProps {
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
  disabled?: boolean;
  onChange: (value: number) => void;
}

function NumberField({ label, hint, value, step = 1, min, max, disabled, onChange }: FieldProps) {
  const field = useNumberField(value, onChange);
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input type="number" step={step} min={min} max={max} disabled={disabled} {...field} />
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

const SPEED_UNIT_LABELS: Record<WalkSpeedUnit, string> = { minkm: "min/km", kmh: "km/h", ms: "m/s" };
const RATE_UNIT_LABELS: Record<FatOxRateUnit, string> = { gmin: "g/min", ghour: "g/hour" };

interface FatOxRowProps {
  point: FatOxPoint;
  speedUnit: WalkSpeedUnit;
  rateUnit: FatOxRateUnit;
  onChange: (patch: Partial<FatOxPoint>) => void;
  onRemove: () => void;
}

function FatOxRow({ point, speedUnit, rateUnit, onChange, onRemove }: FatOxRowProps) {
  const paceField = useNumberField(
    Math.round(paceMinPerKmToDisplay(point.paceMinPerKm, speedUnit) * 100) / 100,
    (v) => onChange({ paceMinPerKm: displayToPaceMinPerKm(v, speedUnit) }),
  );
  const fatField = useNumberField(Math.round(rateFromGPerMin(point.fatGPerMin, rateUnit) * 1000) / 1000, (v) =>
    onChange({ fatGPerMin: rateToGPerMin(v, rateUnit) }),
  );
  const carbField = useNumberField(Math.round(rateFromGPerMin(point.carbGPerMin, rateUnit) * 1000) / 1000, (v) =>
    onChange({ carbGPerMin: rateToGPerMin(v, rateUnit) }),
  );

  return (
    <div className="fatox-row">
      <input type="number" step={0.05} min={0} {...paceField} aria-label={`Pace, ${SPEED_UNIT_LABELS[speedUnit]}`} />
      <span className="fatox-row__unit">{SPEED_UNIT_LABELS[speedUnit]}</span>
      <input
        type="number"
        step={0.01}
        min={0}
        {...fatField}
        aria-label={`Fat oxidation, ${RATE_UNIT_LABELS[rateUnit]}`}
      />
      <span className="fatox-row__unit">{RATE_UNIT_LABELS[rateUnit]} fat</span>
      <input
        type="number"
        step={0.01}
        min={0}
        {...carbField}
        aria-label={`Carb oxidation, ${RATE_UNIT_LABELS[rateUnit]}`}
      />
      <span className="fatox-row__unit">{RATE_UNIT_LABELS[rateUnit]} carb</span>
      <input
        type="number"
        step={1}
        min={0}
        placeholder="HR"
        value={point.heartRateBpm ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onChange({ heartRateBpm: raw === "" ? undefined : Number(raw) });
        }}
        aria-label="Heart rate at this stage, bpm (optional -- lets this point feed the HR calibration)"
      />
      <span className="fatox-row__unit">bpm</span>
      <button type="button" className="fatox-row__remove" onClick={onRemove} aria-label="Remove point">
        &times;
      </button>
    </div>
  );
}

interface FatOxRowsProps {
  points: FatOxPoint[];
  speedUnit: WalkSpeedUnit;
  rateUnit: FatOxRateUnit;
  onSpeedUnitChange: (unit: WalkSpeedUnit) => void;
  onRateUnitChange: (unit: FatOxRateUnit) => void;
  onChange: (points: FatOxPoint[]) => void;
}

function FatOxRows({ points, speedUnit, rateUnit, onSpeedUnitChange, onRateUnitChange, onChange }: FatOxRowsProps) {
  const update = (i: number, patch: Partial<FatOxPoint>) =>
    onChange(points.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange(points.filter((_, idx) => idx !== i));
  const add = () => onChange([...points, { paceMinPerKm: 6, fatGPerMin: 0.4, carbGPerMin: 1.5 }]);

  return (
    <div className="fatox-rows">
      {points.length > 0 && (
        <div className="fatox-units">
          <label>
            Pace unit
            <select
              className="field__unit-select"
              value={speedUnit}
              onChange={(e) => onSpeedUnitChange(e.target.value as WalkSpeedUnit)}
            >
              <option value="minkm">min/km</option>
              <option value="kmh">km/h</option>
              <option value="ms">m/s</option>
            </select>
          </label>
          <label>
            Fat/carb unit
            <select
              className="field__unit-select"
              value={rateUnit}
              onChange={(e) => onRateUnitChange(e.target.value as FatOxRateUnit)}
            >
              <option value="gmin">g/min</option>
              <option value="ghour">g/hour</option>
            </select>
          </label>
        </div>
      )}
      {points.map((p, i) => (
        <FatOxRow
          key={i}
          point={p}
          speedUnit={speedUnit}
          rateUnit={rateUnit}
          onChange={(patch) => update(i, patch)}
          onRemove={() => remove(i)}
        />
      ))}
      <button type="button" className="fatox-add" onClick={add}>
        + Add point
      </button>
    </div>
  );
}

const VO2MAX_SOURCE_LABELS: Record<Vo2MaxSource, string> = {
  lab: "Lab test",
  race: "Race performance",
  wearable: "Wearable estimate",
  manual: "Manual guess",
};

interface Vo2MaxRowProps {
  entry: Vo2MaxEntry;
  onChange: (patch: Partial<Vo2MaxEntry>) => void;
  onRemove: () => void;
}

function Vo2MaxRow({ entry, onChange, onRemove }: Vo2MaxRowProps) {
  const valueField = useNumberField(entry.value, (v) => onChange({ value: v }));
  return (
    <div className="vo2max-row">
      <input
        type="date"
        value={entry.date}
        onChange={(e) => onChange({ date: e.target.value })}
        aria-label="Measurement date"
      />
      <input type="number" step={1} min={20} {...valueField} aria-label="VO2max, ml/kg/min" />
      <span className="fatox-row__unit">ml/kg/min</span>
      <select
        className="field__unit-select"
        value={entry.source}
        onChange={(e) => onChange({ source: e.target.value as Vo2MaxSource })}
        aria-label="Source"
      >
        {Object.entries(VO2MAX_SOURCE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button type="button" className="fatox-row__remove" onClick={onRemove} aria-label="Remove entry">
        &times;
      </button>
    </div>
  );
}

interface Vo2MaxRowsProps {
  history: Vo2MaxEntry[];
  onChange: (history: Vo2MaxEntry[]) => void;
}

function Vo2MaxRows({ history, onChange }: Vo2MaxRowsProps) {
  const update = (i: number, patch: Partial<Vo2MaxEntry>) =>
    onChange(history.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const remove = (i: number) => onChange(history.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([
      ...history,
      { date: new Date().toISOString().slice(0, 10), value: Math.round(resolveVo2Max(history) ?? 50), source: "manual" },
    ]);

  return (
    <div className="fatox-rows">
      {history.map((entry, i) => (
        <Vo2MaxRow key={i} entry={entry} onChange={(patch) => update(i, patch)} onRemove={() => remove(i)} />
      ))}
      <button type="button" className="fatox-add" onClick={add}>
        + Add entry
      </button>
    </div>
  );
}

interface LtThresholdFieldProps {
  label: string;
  paceMinPerKm: number | null;
  heartRateBpm: number | null;
  fraction: number;
  fractionMin: number;
  fractionMax: number;
  walkMaxMs: number;
  vo2Max: number | undefined;
  /** Pace to seed the field with on switching into pace mode -- just a
   * plausible starting point for the user to overwrite, not a real guess. */
  defaultPaceMinPerKm: number;
  onFractionChange: (v: number) => void;
  onPaceChange: (v: number | null) => void;
  onHeartRateChange: (v: number | null) => void;
}

/**
 * LT1/LT2 as either a raw %VO2max fraction (the base representation) or a
 * pace + heart rate the athlete actually knows -- pace converts to the
 * equivalent fraction via the same Minetti pace->power conversion the fat-ox
 * curve uses (paceToVo2MaxFraction); heart rate is reference-only (this
 * app's ceiling model is power/pace-based, not HR-based) and just carried
 * alongside for the athlete's own record.
 */
function LtThresholdField({
  label,
  paceMinPerKm,
  heartRateBpm,
  fraction,
  fractionMin,
  fractionMax,
  walkMaxMs,
  vo2Max,
  defaultPaceMinPerKm,
  onFractionChange,
  onPaceChange,
  onHeartRateChange,
}: LtThresholdFieldProps) {
  const usingPace = paceMinPerKm !== null;
  return (
    <>
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={usingPace}
          onChange={(e) => onPaceChange(e.target.checked ? defaultPaceMinPerKm : null)}
        />
        <span>Enter {label} as pace + pulse instead</span>
      </label>
      {!usingPace && (
        <NumberField
          label={label}
          hint="fraction of VO2max"
          value={fraction}
          step={0.01}
          min={fractionMin}
          max={fractionMax}
          onChange={onFractionChange}
        />
      )}
      {usingPace && (
        <>
          <NumberField
            label={`${label} pace`}
            hint="min/km"
            value={paceMinPerKm}
            step={0.05}
            min={2}
            onChange={onPaceChange}
          />
          <NumberField
            label={`${label} heart rate`}
            hint="bpm, reference only -- not used in any calculation"
            value={heartRateBpm ?? 0}
            step={1}
            min={0}
            onChange={(v) => onHeartRateChange(v > 0 ? v : null)}
          />
          <p className="field-group-note">
            ≈ {(paceToVo2MaxFraction(paceMinPerKm, walkMaxMs, vo2Max) * 100).toFixed(0)}% of VO2max
          </p>
        </>
      )}
    </>
  );
}

/** Athlete physiology, fueling, pacing fade, and walk/run settings (Page 2). */
export function AthleteFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  const usingFatOxCurve = values.fatOxPoints.length > 0;
  const equivalentThresholds = useMemo(() => equivalentLT1LT2(values), [values]);
  const theoreticalFatOxCurve = useMemo(() => {
    const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(values);
    return generateTheoreticalFatOxCurve({
      lt1Fraction,
      lt2Fraction,
      vo2MaxMlPerKgPerMin: resolveVo2Max(values.vo2MaxHistory) ?? 50,
      bodyMassKg: values.bodyMassKg,
      foPeakGPerMin: values.foPeakGPerMin,
      walkMaxMs: values.walkMaxMs,
    });
  }, [
    values.lt1Fraction,
    values.lt2Fraction,
    values.lt1PaceMinPerKm,
    values.lt2PaceMinPerKm,
    values.vo2MaxHistory,
    values.bodyMassKg,
    values.foPeakGPerMin,
    values.walkMaxMs,
  ]);

  return (
    <div className="inputs-panel">
      <fieldset>
        <legend>Athlete</legend>
        <p className="field-group-help">Body mass, VO2max, and LT2 are the minimum for a working plan.</p>
        <NumberField
          label="Body mass"
          hint="kg"
          value={values.bodyMassKg}
          step={0.5}
          min={30}
          onChange={(v) => set("bodyMassKg", v)}
        />
        <p className="field-group-note">
          Current effective VO2max: {(resolveVo2Max(values.vo2MaxHistory) ?? 50).toFixed(1)} ml/kg/min, combining{" "}
          {values.vo2MaxHistory.length} entr{values.vo2MaxHistory.length === 1 ? "y" : "ies"}.
        </p>
        <p className="field-group-help">Add every VO2max measurement you have, dated and sourced.</p>
        <Vo2MaxRows history={values.vo2MaxHistory} onChange={(vo2MaxHistory) => set("vo2MaxHistory", vo2MaxHistory)} />
        <LtThresholdField
          label="LT2"
          paceMinPerKm={values.lt2PaceMinPerKm}
          heartRateBpm={values.lt2HeartRateBpm}
          fraction={values.lt2Fraction}
          fractionMin={values.lt1Fraction + 0.01}
          fractionMax={0.99}
          walkMaxMs={values.walkMaxMs}
          vo2Max={resolveVo2Max(values.vo2MaxHistory)}
          defaultPaceMinPerKm={5.0}
          onFractionChange={(v) => set("lt2Fraction", v)}
          onPaceChange={(v) => set("lt2PaceMinPerKm", v)}
          onHeartRateChange={(v) => set("lt2HeartRateBpm", v)}
        />
      </fieldset>

      <fieldset>
        <legend>Fuel split</legend>
        <p className="field-group-help">
          Sets your fat-vs-carb split by effort. Enter LT1 below, or add a real fat-ox curve for fewer assumptions.
        </p>
        <LtThresholdField
          label="LT1"
          paceMinPerKm={values.lt1PaceMinPerKm}
          heartRateBpm={values.lt1HeartRateBpm}
          fraction={values.lt1Fraction}
          fractionMin={0.1}
          fractionMax={0.95}
          walkMaxMs={values.walkMaxMs}
          vo2Max={resolveVo2Max(values.vo2MaxHistory)}
          defaultPaceMinPerKm={6.0}
          onFractionChange={(v) => set("lt1Fraction", v)}
          onPaceChange={(v) => set("lt1PaceMinPerKm", v)}
          onHeartRateChange={(v) => set("lt1HeartRateBpm", v)}
        />
        {usingFatOxCurve && (
          <p className="field-group-note">
            LT1/LT2 unused — your fat-ox curve is active instead.
            {equivalentThresholds && (
              <>
                {" "}
                (≈LT1 {(equivalentThresholds.lt1Fraction * 100).toFixed(0)}%, LT2{" "}
                {(equivalentThresholds.lt2Fraction * 100).toFixed(0)}% of VO2max, for reference.)
              </>
            )}
          </p>
        )}
        {!usingFatOxCurve && <FatOxCurveChart points={theoreticalFatOxCurve} />}
        <details>
          <summary>Advanced: full fat-ox curve (overrides LT1/LT2 above)</summary>
          <p className="field-group-help">
            Enter fat and carb oxidation rates from a metabolic test. Add 2-3+ points across a range of paces,
            measured on flat ground.
          </p>
          <FatOxRows
            points={values.fatOxPoints}
            speedUnit={values.fatOxSpeedDisplayUnit}
            rateUnit={values.fatOxRateDisplayUnit}
            onSpeedUnitChange={(unit) => set("fatOxSpeedDisplayUnit", unit)}
            onRateUnitChange={(unit) => set("fatOxRateDisplayUnit", unit)}
            onChange={(fatOxPoints) => {
              const peak = suggestedFoPeakGPerMin(fatOxPoints);
              onChange({ ...values, fatOxPoints, ...(peak !== null ? { foPeakGPerMin: peak } : {}) });
            }}
          />
          <NumberField
            label="Fat oxidation peak"
            hint={RATE_UNIT_LABELS[values.fatOxRateDisplayUnit]}
            value={Math.round(rateFromGPerMin(values.foPeakGPerMin, values.fatOxRateDisplayUnit) * 1000) / 1000}
            step={values.fatOxRateDisplayUnit === "ghour" ? 3 : 0.05}
            min={values.fatOxRateDisplayUnit === "ghour" ? 6 : 0.1}
            onChange={(v) => set("foPeakGPerMin", rateToGPerMin(v, values.fatOxRateDisplayUnit))}
          />
          {usingFatOxCurve && (
            <p className="field-group-note">Auto-filled from your highest measured rate above — override if your true peak is higher.</p>
          )}
        </details>
      </fieldset>

      <fieldset>
        <legend>Pacing curve</legend>
        <p className="field-group-help">Fit automatically from your race history below, or leave at the defaults.</p>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.pacingCurveEnabled}
            onChange={(e) => set("pacingCurveEnabled", e.target.checked)}
          />
          <span>Enable pacing curve</span>
        </label>
        {!values.pacingCurveEnabled && (
          <p className="field-group-note">Off — your plan uses a single flat effort level for the whole event.</p>
        )}
        {values.pacingCurveEnabled && (
          <p className="field-group-note">
            Current: f0 {values.f0.toFixed(2)}, f_inf {values.fInf.toFixed(2)}, tau {values.tauMin} min.
          </p>
        )}
        <details>
          <summary>Advanced: override the pacing curve manually</summary>
          <p className="field-group-help">
            Models how your sustainable effort fades with duration: starts at <strong>f0</strong>, decays to{" "}
            <strong>f_inf</strong> over <strong>tau</strong> minutes. Only change if you know your own fade rate and
            don't want the fit above.
          </p>
          <NumberField
            label="f0"
            hint="starting sustainable fraction"
            value={values.f0}
            step={0.01}
            min={0.5}
            max={1}
            disabled={!values.pacingCurveEnabled}
            onChange={(v) => set("f0", v)}
          />
          <NumberField
            label="f_inf"
            hint="asymptotic sustainable fraction"
            value={values.fInf}
            step={0.01}
            min={0.1}
            max={0.9}
            disabled={!values.pacingCurveEnabled}
            onChange={(v) => set("fInf", v)}
          />
          <NumberField
            label="tau"
            hint="minutes, decay time constant"
            value={values.tauMin}
            step={10}
            min={10}
            disabled={!values.pacingCurveEnabled}
            onChange={(v) => set("tauMin", v)}
          />
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={values.durabilityDriftPerHour > 0}
              disabled={!values.pacingCurveEnabled}
              onChange={(e) => set("durabilityDriftPerHour", e.target.checked ? 0.01 : 0)}
            />
            <span>Durability drift</span>
          </label>
          <p className="field-group-help">Extra fade for accumulated muscular fatigue on very long days. Off by default.</p>
          {values.durabilityDriftPerHour > 0 && (
            <NumberField
              label="Drift rate"
              hint="fraction lost per hour"
              value={values.durabilityDriftPerHour}
              step={0.001}
              min={0}
              max={0.1}
              disabled={!values.pacingCurveEnabled}
              onChange={(v) => set("durabilityDriftPerHour", v)}
            />
          )}
        </details>
      </fieldset>

      <fieldset>
        <legend>Terrain surface cost</legend>
        <p className="field-group-help">Fit automatically from your past runs below.</p>
        {values.surfaceCostMultipliers && Object.keys(values.surfaceCostMultipliers).length > 0 && (
          <p className="field-group-note">
            Current per-category fit:{" "}
            {Object.entries(values.surfaceCostMultipliers)
              .map(([category, multiplier]) => `${category} ${multiplier!.toFixed(2)}x`)
              .join(", ")}
            .
          </p>
        )}
        <details>
          <summary>Advanced: flat fallback / manual override</summary>
          <p className="field-group-help">Only change if you don't want to rely on the fit above.</p>
          <p className="field-group-note">
            Current: {values.unpavedCostMultiplier.toFixed(2)}x (
            {((values.unpavedCostMultiplier - 1) * 100).toFixed(0)}% slower on unpaved terrain).
          </p>
          <NumberField
            label="Cost multiplier"
            hint="e.g. 1.5 = 50% slower on unpaved"
            value={values.unpavedCostMultiplier}
            step={0.05}
            min={1}
            max={4}
            onChange={(v) => set("unpavedCostMultiplier", v)}
          />
        </details>
      </fieldset>

      <fieldset>
        <legend>Walk / run</legend>
        <p className="field-group-help">Your fastest sustainable walk. Force-walk overrides it for grades you'd never run.</p>
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

/** Per-race fueling plan: carb intake and glycogen store (Course page) --
 * genuinely race-specific (carb-loaded or not, aid-station plan or not),
 * unlike the one-time athlete physiology in AthleteFields above. */
export function FuelingFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <div className="inputs-panel">
      <fieldset>
        <legend>Fueling</legend>
        <p className="field-group-help">
          Assumes everything you enter gets absorbed -- don't exceed ~60 g/h (glucose-only) or ~90 g/h
          (glucose+fructose), a real gut's limit.
        </p>
        <NumberField
          label="Carb intake"
          hint="g/h"
          value={values.intakeGPerH}
          step={5}
          min={0}
          onChange={(v) => set("intakeGPerH", v)}
        />
        <NumberField
          label="Glycogen store"
          hint="g/kg body mass"
          value={values.glycogenGPerKg}
          step={0.1}
          min={0}
          onChange={(v) => set("glycogenGPerKg", v)}
        />
        <p className="field-group-note">
          ≈ {resolveGlycogenStoreG(values).toFixed(0)} g total at {values.bodyMassKg} kg body mass.
        </p>
        <p className="field-group-help">
          ~7-8 g/kg is typical for a fed, trained athlete. Carb-loading pushes it higher; fasted or fatigued pushes
          it lower.
        </p>
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
        <p className="field-group-help">Cleans up noisy GPS data. Leave at defaults unless your course is unusually sparse/noisy.</p>
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
