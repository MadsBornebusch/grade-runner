import { useState } from "react";
import { Bed, CheckCircle, Heartbeat, Minus, Plus, SmileyMeh, SmileySad, Smiley, SmileyWink } from "@phosphor-icons/react";
import { checkinStore, type Checkin } from "../../storage/checkins";
import { planSettingsStore } from "../../storage/planSettings";
import { dateOfDayNumber } from "../../plan/historyFromRuns";
import { formatMinutesExact } from "./planCopy";

const QUALITY = [
  { v: 1, label: "Poor", icon: SmileySad },
  { v: 2, label: "OK", icon: SmileyMeh },
  { v: 3, label: "Good", icon: Smiley },
  { v: 4, label: "Great", icon: SmileyWink },
] as const;

/** Morning check-in (sleep, morning HRV), by hand until Garmin health data
 * is connected. Optional, skippable, one line once answered. */
export function CheckinCard({ today, hour }: { today: number; hour: number }) {
  const store = checkinStore.use();
  const enabled = planSettingsStore.use().checkinsEnabled;
  const key = dateOfDayNumber(today);
  const saved = store.byDate[key];
  const lastSleep = Object.entries(store.byDate).filter(([d, c]) => d < key && c.sleepH).sort().at(-1)?.[1].sleepH ?? 7;
  const [sleepH, setSleepH] = useState(lastSleep);
  const [quality, setQuality] = useState<Checkin["sleepQuality"]>();
  const [hrv, setHrv] = useState("");
  const [open, setOpen] = useState(false);
  if (!enabled) return null;

  const save = (c: Checkin) => checkinStore.set((s) => ({ ...s, byDate: { ...s.byDate, [key]: c } }));
  const week = Object.entries(store.byDate)
    .filter(([d, c]) => d <= key && d > dateOfDayNumber(today - 7) && c.hrvMs)
    .map(([, c]) => c.hrvMs!);

  if (saved && !saved.skipped) {
    return (
      <div className="card checkin checkin--done">
        <CheckCircle size={20} weight="fill" className="success" aria-hidden="true" />
        <span className="num">
          {saved.sleepH !== undefined && `Slept ${formatMinutesExact(saved.sleepH * 60)}`}
          {saved.sleepQuality && ` · ${QUALITY[saved.sleepQuality - 1].label.toLowerCase()}`}
          {saved.hrvMs && ` · HRV ${saved.hrvMs} ms`}
          {week.length >= 3 && ` (7-day average ${Math.round(week.reduce((a, b) => a + b, 0) / week.length)})`}
        </span>
      </div>
    );
  }

  // Collapsed: after a skip, or after noon (no morning HRV any more).
  if (!open && (saved?.skipped || hour >= 12)) {
    return (
      <button type="button" className="card checkin checkin--line" onClick={() => setOpen(true)}>
        <Bed size={20} weight="duotone" aria-hidden="true" /> Add sleep & HRV
      </button>
    );
  }

  return (
    <div className="card checkin">
      <div className="checkin__head">
        <h3 className="card-title">Good morning</h3>
        <button type="button" className="link-button" onClick={() => planSettingsStore.set((s) => ({ ...s, checkinsEnabled: false }))}>
          Don't ask
        </button>
      </div>
      <div className="checkin__row">
        <span className="checkin__label">
          <Bed size={18} /> Sleep
        </span>
        <div className="stepper stepper--small">
          <button type="button" aria-label="Less sleep" onClick={() => setSleepH((h) => Math.max(0, h - 0.25))}>
            <Minus size={16} weight="bold" />
          </button>
          <span className="stepper__value num">{formatMinutesExact(sleepH * 60)}</span>
          <button type="button" aria-label="More sleep" onClick={() => setSleepH((h) => Math.min(14, h + 0.25))}>
            <Plus size={16} weight="bold" />
          </button>
        </div>
      </div>
      <div className="choice-row" role="radiogroup" aria-label="Sleep quality">
        {QUALITY.map(({ v, label, icon: I }) => (
          <button key={v} type="button" role="radio" aria-checked={quality === v} className={quality === v ? "choice choice--on choice--icon" : "choice choice--icon"} onClick={() => setQuality(v)}>
            <I size={22} weight={quality === v ? "fill" : "duotone"} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <label className="checkin__row">
        <span className="checkin__label">
          <Heartbeat size={18} /> Morning HRV
        </span>
        <span className="input-unit">
          <input type="number" inputMode="numeric" placeholder="e.g. 52" value={hrv} onChange={(e) => setHrv(e.target.value)} />
          ms
        </span>
      </label>
      <div className="sheet__actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            const ms = Number(hrv);
            save({ sleepH, sleepQuality: quality, hrvMs: hrv && ms > 0 ? ms : undefined });
          }}
        >
          Save
        </button>
        <button type="button" className="button-ghost" onClick={() => { save({ skipped: true }); setOpen(false); }}>
          Not today
        </button>
      </div>
      <p className="help">Soon: on low-HRV days the plan will suggest an easier session.</p>
    </div>
  );
}
