import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  displayToPaceMinPerKm,
  equivalentLT1LT2,
  paceMinPerKmToDisplay,
  paceToVo2MaxFraction,
  rateFromGPerMin,
  rateToGPerMin,
  resolveGlycogenStoreG,
  resolveHrZones,
  resolveVo2Max,
  speedFromMs,
  speedToMs,
  suggestedFoPeakGPerMin,
  type FatOxPoint,
  type FatOxRateUnit,
  type FormInputs,
  type HrZone,
  type Vo2MaxEntry,
  type Vo2MaxSource,
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

interface CustomHrZoneRowProps {
  zone: HrZone;
  onChange: (patch: Partial<HrZone>) => void;
  onRemove: () => void;
}

function CustomHrZoneRow({ zone, onChange, onRemove }: CustomHrZoneRowProps) {
  const loField = useNumberField(zone.loBpm, (v) => onChange({ loBpm: v }));
  const hiField = useNumberField(zone.hiBpm, (v) => onChange({ hiBpm: v }));
  return (
    <div className="vo2max-row">
      <input
        type="text"
        value={zone.label}
        onChange={(e) => onChange({ label: e.target.value })}
        aria-label="Zone label"
      />
      <input type="number" step={1} min={0} {...loField} aria-label="Low bpm" />
      <span className="fatox-row__unit">–</span>
      <input type="number" step={1} min={0} {...hiField} aria-label="High bpm" />
      <span className="fatox-row__unit">bpm</span>
      <button type="button" className="fatox-row__remove" onClick={onRemove} aria-label="Remove zone">
        &times;
      </button>
    </div>
  );
}

interface CustomHrZoneRowsProps {
  zones: HrZone[];
  onChange: (zones: HrZone[]) => void;
}

function CustomHrZoneRows({ zones, onChange }: CustomHrZoneRowsProps) {
  const update = (i: number, patch: Partial<HrZone>) => onChange(zones.map((z, idx) => (idx === i ? { ...z, ...patch } : z)));
  const remove = (i: number) => onChange(zones.filter((_, idx) => idx !== i));
  const add = () => onChange([...zones, { label: `Zone ${zones.length + 1}`, loBpm: 100, hiBpm: 140 }]);

  return (
    <div className="fatox-rows">
      {zones.map((zone, i) => (
        <CustomHrZoneRow key={i} zone={zone} onChange={(patch) => update(i, patch)} onRemove={() => remove(i)} />
      ))}
      <button type="button" className="fatox-add" onClick={add}>
        + Add zone
      </button>
    </div>
  );
}

/** Athlete physiology, fueling, pacing fade, and walk/run settings (Page 2). */
export function AthleteFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) =>
    onChange({ ...values, [key]: value });

  const usingFatOxCurve = values.fatOxPoints.length > 0;
  const equivalentThresholds = useMemo(() => equivalentLT1LT2(values), [values]);
  const hrZones = useMemo(() => resolveHrZones(values), [values]);

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
        <p className="field-group-note">
          Current effective VO2max: {(resolveVo2Max(values.vo2MaxHistory) ?? 50).toFixed(1)} ml/kg/min, combining{" "}
          {values.vo2MaxHistory.length} entr{values.vo2MaxHistory.length === 1 ? "y" : "ies"}.
        </p>
        <p className="field-group-help">
          Add every VO2max measurement you have, dated and with its source — a lab test outweighs a wearable guess,
          and older entries matter less as you train (see PLAN.md §12). One entry works fine too; it's just used
          directly.
        </p>
        <Vo2MaxRows history={values.vo2MaxHistory} onChange={(vo2MaxHistory) => set("vo2MaxHistory", vo2MaxHistory)} />
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
        {usingFatOxCurve && (
          <p className="field-group-note">
            LT1/LT2 are unused — your fat oxidation curve below is active instead.
            {equivalentThresholds && (
              <>
                {" "}
                For reference, your curve is equivalent to LT1 ≈ {(equivalentThresholds.lt1Fraction * 100).toFixed(0)}
                % and LT2 ≈ {(equivalentThresholds.lt2Fraction * 100).toFixed(0)}% of the VO2max above. VO2max itself
                isn't derived from the curve — a submaximal fat-ox test can't tell us where your true ceiling is — so
                it still needs its own source and keeps governing your pace ceiling independently.
              </>
            )}
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Fat oxidation curve</legend>
        <details>
          <summary>Advanced: full fat-ox curve (overrides LT1/LT2 above)</summary>
          <p className="field-group-help">
            If you know your fat and carb oxidation rates at different paces (e.g. from a metabolic test), enter both
            here instead of relying on the default LT1/LT2 curve — the model needs both numbers to work out the fuel
            split at that pace. Add at least 2-3 points across a range of paces for a reliable fit — one point just
            shifts the default curve. Assumes the points were measured on flat ground.
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
            <p className="field-group-note">
              Auto-filled from your highest measured fat-oxidation rate above — override if you know your true peak is
              higher (e.g. the test didn't reach it).
            </p>
          )}
        </details>
      </fieldset>

      <fieldset>
        <legend>Pacing curve</legend>
        <p className="field-group-help">
          How much of your aerobic max you can hold shrinks the longer you race — you can hold a high effort briefly,
          but only a much lower one all day. This curve models that fade: it starts near <strong>f0</strong> (the
          fraction of max you can hold at the start) and decays toward <strong>f_inf</strong> (the fraction you can
          sustain indefinitely), with <strong>tau</strong> controlling how many minutes that fade takes. Found from
          fitting your own past runs below (see the Strava/fit section) whenever that fit clears its own quality bar,
          or left at reasonable defaults otherwise.
        </p>
        <p className="field-group-note">
          Current: f0 {values.f0.toFixed(2)}, f_inf {values.fInf.toFixed(2)}, tau {values.tauMin} min.
        </p>
        <details>
          <summary>Advanced: override the pacing curve manually</summary>
          <p className="field-group-help">
            Only change these if you know how you personally fade over a long race (e.g. from pacing data on a past
            ultra) and don't want to rely on the fit below.
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
        </details>
      </fieldset>

      <fieldset>
        <legend>Terrain surface cost</legend>
        <p className="field-group-help">
          Unpaved/technical trail costs more to move across than pavement at the same gradient -- this multiplies
          the running/walking cost curve while actually on unpaved terrain, with no carryover once you're back on
          pavement. Found from fitting your own past runs with surface data below (see the Strava/fit section)
          whenever that fit clears its own quality bar, or left at 1 (no effect) otherwise.
        </p>
        <p className="field-group-note">
          Current: {values.unpavedCostMultiplier.toFixed(2)}x (
          {((values.unpavedCostMultiplier - 1) * 100).toFixed(0)}% slower on unpaved terrain).
        </p>
        <details>
          <summary>Advanced: override manually</summary>
          <p className="field-group-help">
            Only change this if you know how much slower you personally move on technical terrain and don't want to
            rely on the fit below.
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
        <legend>Heart rate zones</legend>
        <p className="field-group-help">
          Reference/display only -- this app's ceiling model is power/pace-based, not HR-based, so these zone
          boundaries aren't fed into any calculation (the HR-effort calibration below is the one place HR actually
          drives a number, and it's kept separate from these zones).
        </p>
        <label className="field">
          <span className="field__label">Zone model</span>
          <select
            value={values.hrZoneModel ?? ""}
            onChange={(e) => set("hrZoneModel", (e.target.value || null) as FormInputs["hrZoneModel"])}
          >
            <option value="">Not configured</option>
            <option value="hrmax">% of max HR</option>
            <option value="hrr">% heart rate reserve (Karvonen)</option>
            <option value="lthr">% of threshold HR</option>
            <option value="custom">Custom boundaries</option>
          </select>
        </label>
        {(values.hrZoneModel === "hrmax" || values.hrZoneModel === "hrr") && (
          <NumberField
            label="Max HR"
            hint="bpm"
            value={values.maxHrBpm ?? 0}
            step={1}
            min={0}
            onChange={(v) => set("maxHrBpm", v > 0 ? v : null)}
          />
        )}
        {values.hrZoneModel === "hrr" && (
          <NumberField
            label="Resting HR"
            hint="bpm"
            value={values.restHrBpm ?? 0}
            step={1}
            min={0}
            onChange={(v) => set("restHrBpm", v > 0 ? v : null)}
          />
        )}
        {values.hrZoneModel === "lthr" && (
          <NumberField
            label="Threshold HR"
            hint="bpm"
            value={values.thresholdHrBpm ?? 0}
            step={1}
            min={0}
            onChange={(v) => set("thresholdHrBpm", v > 0 ? v : null)}
          />
        )}
        {values.hrZoneModel === "custom" && (
          <CustomHrZoneRows zones={values.customHrZones ?? []} onChange={(customHrZones) => set("customHrZones", customHrZones)} />
        )}
        {hrZones && (
          <ul className="run-library__fit-notes">
            {hrZones.map((z, i) => (
              <li key={i} className="field-group-note">
                {z.label}: {z.loBpm.toFixed(0)}–{z.hiBpm.toFixed(0)} bpm
              </li>
            ))}
          </ul>
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
          Your fueling plan for this race, and your body's carb tank. The model assumes everything you plan to take
          in gets absorbed and used — it doesn't enforce a gut-absorption ceiling itself, so don't plan for much more
          than a real gut can handle: roughly 60 g/h for glucose-only products, up to ~90 g/h with glucose+fructose
          mixes (common in modern gels/drinks). Planning above that overstates how much carb you're actually getting.
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
          ~7-8 g/kg (liver + muscle glycogen) is typical for a fed, trained endurance athlete. Carb-loading in the
          days before a big race can push this higher; starting already fasted, tapered off carbs, or fatigued from
          back-to-back hard days should push it lower.
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
