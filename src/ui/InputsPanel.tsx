import { useMemo, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
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
  /** Short unit after the input ("kg", "bpm"). */
  unit?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function NumberField({ label, unit, value, step = 1, min, max, disabled, onChange }: FieldProps) {
  const field = useNumberField(value, onChange);
  return (
    <label className="form-row">
      <span>{label}</span>
      <span className="input-unit">
        <input type="number" step={step} min={min} max={max} disabled={disabled} {...field} />
        {unit}
      </span>
    </label>
  );
}

/** "4:57" <-> 4.95 min/km. */
const formatPace = (min: number) => {
  const total = Math.round(min * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
function parsePace(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const min = Number(m[1]) + Number(m[2] ?? 0) / 60;
  return min >= 2 && min <= 20 ? min : null;
}

function PaceField({ label, value, onChange }: { label: string; value: number; onChange: (min: number) => void }) {
  const [text, setText] = useState(formatPace(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : formatPace(value);
  return (
    <label className="form-row">
      <span>{label}</span>
      <span className="input-unit">
        <input
          type="text"
          inputMode="numeric"
          value={shown}
          onFocus={() => {
            setText(formatPace(value));
            setEditing(true);
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => {
            setText(e.target.value);
            const next = parsePace(e.target.value);
            if (next !== null) onChange(next);
          }}
        />
        min/km
      </span>
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
    <label className="form-row">
      <span>{label}</span>
      <span className="input-unit">
        <input type="number" step={0.1} min={0} {...field} />
        <select className="unit-select" value={unit} onChange={(e) => onUnitChange(e.target.value as WalkSpeedUnit)} aria-label={`${label} unit`}>
          <option value="kmh">km/h</option>
          <option value="minkm">min/km</option>
          <option value="ms">m/s</option>
        </select>
      </span>
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
    <div className="entry-row">
      <input type="date" value={entry.date} onChange={(e) => onChange({ date: e.target.value })} aria-label="Measurement date" />
      <input type="number" step={1} min={20} {...valueField} aria-label="VO2max, ml/kg/min" />
      <select value={entry.source} onChange={(e) => onChange({ source: e.target.value as Vo2MaxSource })} aria-label="Source">
        {Object.entries(VO2MAX_SOURCE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button type="button" className="icon-button entry-row__remove" onClick={onRemove} aria-label="Remove entry">
        <X size={16} />
      </button>
    </div>
  );
}

interface Vo2MaxRowsProps {
  history: Vo2MaxEntry[];
  onChange: (history: Vo2MaxEntry[]) => void;
}

function Vo2MaxRows({ history, onChange }: Vo2MaxRowsProps) {
  const update = (i: number, patch: Partial<Vo2MaxEntry>) => onChange(history.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const remove = (i: number) => onChange(history.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([...history, { date: new Date().toISOString().slice(0, 10), value: Math.round(resolveVo2Max(history) ?? 50), source: "manual" }]);
  return (
    <div className="entry-rows">
      {history.map((entry, i) => (
        <Vo2MaxRow key={i} entry={entry} onChange={(patch) => update(i, patch)} onRemove={() => remove(i)} />
      ))}
      <button type="button" className="link-button" onClick={add}>
        <Plus size={14} /> Add a measurement
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
 * LT1/LT2 as either a %VO2max (the base representation, shown as a
 * percentage) or a pace the athlete knows -- pace converts to the
 * equivalent fraction via the same Minetti pace->power conversion the fat-ox
 * curve uses (paceToVo2MaxFraction). Heart rate is entered in either mode:
 * the ceiling model is power/pace-based and ignores it, but the training
 * plan's effort targets and the threshold HR calibration use it.
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
    <div className="threshold">
      <h4 className="threshold__title">{label}</h4>
      <label className="form-row">
        <span>Heart rate</span>
        <span className="input-unit">
          <input
            type="number"
            step={1}
            min={0}
            placeholder="not set"
            value={heartRateBpm ?? ""}
            onChange={(e) => onHeartRateChange(e.target.value === "" || !(Number(e.target.value) > 0) ? null : Number(e.target.value))}
          />
          bpm
        </span>
      </label>
      {usingPace ? (
        <>
          <PaceField label="Pace" value={paceMinPerKm} onChange={onPaceChange} />
          <p className="help num">About {(paceToVo2MaxFraction(paceMinPerKm, walkMaxMs, vo2Max) * 100).toFixed(0)}% of VO2max on the flat.</p>
        </>
      ) : (
        <NumberField
          label="Effort"
          unit="% of VO2max"
          value={Math.round(fraction * 1000) / 10}
          step={1}
          min={fractionMin * 100}
          max={fractionMax * 100}
          onChange={(v) => onFractionChange(v / 100)}
        />
      )}
      <label className="switch-row">
        <input type="checkbox" checked={usingPace} onChange={(e) => onPaceChange(e.target.checked ? defaultPaceMinPerKm : null)} />
        <span>I know my {label} pace</span>
      </label>
    </div>
  );
}

/** Athlete settings: body and VO2max, thresholds, walking, and the lab
 * corner (fat-ox curve, manual terrain cost). Fitted values (aerobic
 * ceiling, terrain cost) show on the Runs tab, where they're learned. */
export function AthleteFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) => onChange({ ...values, [key]: value });
  const vo2Max = resolveVo2Max(values.vo2MaxHistory);
  const usingFatOxCurve = values.fatOxPoints.length > 0;
  const equivalentThresholds = useMemo(() => equivalentLT1LT2(values), [values]);
  const { lt1Fraction, lt2Fraction } = resolveLt1Lt2Fractions(values);
  const theoreticalFatOxCurve = useMemo(
    () =>
      generateTheoreticalFatOxCurve({
        lt1Fraction,
        lt2Fraction,
        vo2MaxMlPerKgPerMin: vo2Max ?? 50,
        bodyMassKg: values.bodyMassKg,
        foPeakGPerMin: values.foPeakGPerMin,
        walkMaxMs: values.walkMaxMs,
      }),
    [lt1Fraction, lt2Fraction, vo2Max, values.bodyMassKg, values.foPeakGPerMin, values.walkMaxMs],
  );

  return (
    <>
      <section>
        <h3 className="section-title">You</h3>
        <div className="card">
          <NumberField label="Body mass" unit="kg" value={values.bodyMassKg} step={0.5} min={30} onChange={(v) => set("bodyMassKg", v)} />
          <div className="form-row">
            <span>VO2max</span>
            <span className="num">{(vo2Max ?? 50).toFixed(1)} ml/kg/min</span>
          </div>
          <p className="help">
            From the measurements below; recent ones and lab tests count most. Races on the Runs tab can add estimates.
          </p>
          <Vo2MaxRows history={values.vo2MaxHistory} onChange={(vo2MaxHistory) => set("vo2MaxHistory", vo2MaxHistory)} />
        </div>
      </section>

      <section>
        <h3 className="section-title">Thresholds</h3>
        <div className="card">
          <p className="help">
            LT1 is where fat burning starts to drop (the top of easy); LT2 is about your 1-hour race effort. They set the fuel model and your
            heart-rate targets.
          </p>
          <LtThresholdField
            label="LT1"
            paceMinPerKm={values.lt1PaceMinPerKm}
            heartRateBpm={values.lt1HeartRateBpm}
            fraction={values.lt1Fraction}
            fractionMin={0.1}
            fractionMax={0.95}
            walkMaxMs={values.walkMaxMs}
            vo2Max={vo2Max}
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
            vo2Max={vo2Max}
            defaultPaceMinPerKm={5.0}
            onFractionChange={(v) => set("lt2Fraction", v)}
            onPaceChange={(v) => set("lt2PaceMinPerKm", v)}
            onHeartRateChange={(v) => set("lt2HeartRateBpm", v)}
          />
          {usingFatOxCurve && (
            <p className="help num">
              Your lab fat-oxidation curve sets the fuel split instead of these
              {equivalentThresholds &&
                ` (it puts LT1 at ${(equivalentThresholds.lt1Fraction * 100).toFixed(0)}% and LT2 at ${(equivalentThresholds.lt2Fraction * 100).toFixed(0)}% of VO2max)`}
              .
            </p>
          )}
        </div>
      </section>

      <section>
        <h3 className="section-title">Walking</h3>
        <div className="card">
          <SpeedField
            label="Fastest walk"
            valueMs={values.walkMaxMs}
            unit={values.walkSpeedDisplayUnit}
            onUnitChange={(unit) => set("walkSpeedDisplayUnit", unit)}
            onChange={(ms) => set("walkMaxMs", ms)}
          />
          <p className="help">The planner walks wherever walking is faster than running at the same effort.</p>
          <label className="switch-row">
            <input type="checkbox" checked={values.forceWalkAboveGrade !== null} onChange={(e) => set("forceWalkAboveGrade", e.target.checked ? 0.25 : null)} />
            <span>Always walk climbs steeper than a set grade</span>
          </label>
          {values.forceWalkAboveGrade !== null && (
            <NumberField
              label="Steeper than"
              unit="%"
              value={Math.round(values.forceWalkAboveGrade * 100)}
              step={1}
              min={5}
              max={50}
              onChange={(v) => set("forceWalkAboveGrade", v / 100)}
            />
          )}
        </div>
      </section>

      <details className="lab card">
        <summary>Lab: fuel curve and manual overrides</summary>
        <h4 className="threshold__title">Fat and carb burning by pace</h4>
        <p className="help">
          {usingFatOxCurve ? "From your lab test." : "Estimated from your thresholds. Enter a metabolic test below to replace it."}
        </p>
        {!usingFatOxCurve && <FatOxCurveChart points={theoreticalFatOxCurve} />}
        <p className="help">Fat and carb oxidation from a metabolic test: 2–3 or more stages on the flat. Heart rate per stage sharpens the targets.</p>
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
          label="Peak fat burning"
          unit={RATE_UNIT_LABELS[values.fatOxRateDisplayUnit]}
          value={Math.round(rateFromGPerMin(values.foPeakGPerMin, values.fatOxRateDisplayUnit) * 1000) / 1000}
          step={values.fatOxRateDisplayUnit === "ghour" ? 3 : 0.05}
          min={values.fatOxRateDisplayUnit === "ghour" ? 6 : 0.1}
          onChange={(v) => set("foPeakGPerMin", rateToGPerMin(v, values.fatOxRateDisplayUnit))}
        />
        {usingFatOxCurve && <p className="help">Filled from your highest measured rate; raise it if your true peak is higher.</p>}
        <h4 className="threshold__title">Trail cost without a fit</h4>
        <NumberField
          label="Unpaved ground costs"
          unit="× paved"
          value={values.unpavedCostMultiplier}
          step={0.05}
          min={1}
          max={4}
          onChange={(v) => set("unpavedCostMultiplier", v)}
        />
        <p className="help">Only used until the Runs tab has learned your own terrain costs.</p>
      </details>
    </>
  );
}

/** Per-race fueling plan: carb intake and glycogen store (Course page) --
 * genuinely race-specific (carb-loaded or not, aid-station plan or not),
 * unlike the one-time athlete physiology in AthleteFields above. */
export function FuelingFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) => onChange({ ...values, [key]: value });
  return (
    <section>
      <h3 className="section-title">Race fuelling</h3>
      <div className="card">
        <label className="form-row">
          <span>Carbs during the race</span>
          <span className="input-unit">
            <input type="number" min={0} max={150} step={5} value={values.intakeGPerH} onChange={(e) => set("intakeGPerH", Number(e.target.value) || 0)} />
            g/h
          </span>
        </label>
        <p className="help">
          What you plan to take. A trained gut can take 90–120 g/h of glucose with fructose; your long runs practise toward it. It also sets the
          prediction.
        </p>
        <label className="form-row">
          <span>Glycogen at the start</span>
          <span className="input-unit">
            <input type="number" min={0} max={15} step={0.5} value={values.glycogenGPerKg} onChange={(e) => set("glycogenGPerKg", Number(e.target.value) || 0)} />
            g/kg
          </span>
        </label>
        <p className="help num">
          About {Math.round(resolveGlycogenStoreG(values))} g at {values.bodyMassKg} kg. 7–8 g/kg is typical when fed and rested; carb-loading
          raises it.
        </p>
      </div>
    </section>
  );
}

/** Course processing (Add course › Lab): resample spacing, elevation
 * smoothing, altitude, and the raw-vs-processed debug chart toggle. */
export function CourseProcessingFields({ values, onChange }: FieldsProps) {
  const set = <K extends keyof FormInputs>(key: K, value: FormInputs[K]) => onChange({ ...values, [key]: value });
  return (
    <div className="lab__body">
      <p className="help">Cleans up noisy GPS. Leave as is unless the course is unusually sparse or noisy.</p>
      <NumberField label="Segment length" unit="m" value={values.segmentLengthM} step={5} min={5} onChange={(v) => set("segmentLengthM", v)} />
      <NumberField label="Elevation smoothing" unit="m" value={values.smoothingWindowM} step={5} min={5} onChange={(v) => set("smoothingWindowM", v)} />
      <label className="switch-row">
        <input type="checkbox" checked={values.altitudeAdjustment} onChange={(e) => set("altitudeAdjustment", e.target.checked)} />
        <span>Slow down for altitude</span>
      </label>
      <label className="switch-row">
        <input type="checkbox" checked={values.showCourseDebug} onChange={(e) => set("showCourseDebug", e.target.checked)} />
        <span>Show the raw vs processed chart</span>
      </label>
    </div>
  );
}
