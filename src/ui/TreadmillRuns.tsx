// Treadmill runs from the last PLAN_FULL_DATA_DAYS: lap the watch at every
// grade change, then enter each lap's grade here. The plan then counts the
// run's climb, descent and load from the laps (historyFromRuns.ts
// treadmillLoad).
import { useState } from "react";
import { treadmillCandidates } from "../model/suggestRuns";
import { setStoredRunTreadmillLaps, type StoredRun, type TreadmillLap } from "../storage/runLibrary";
import { fetchStravaLaps } from "./stravaClient";

const lapTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function TreadmillRuns({ runs, onSaved }: { runs: StoredRun[]; onSaved: () => void }) {
  const candidates = treadmillCandidates(runs, Date.now());
  const [open, setOpen] = useState<string | null>(null);
  if (candidates.length === 0) return null;
  return (
    <section>
      <h3 className="section-title">Treadmill runs</h3>
      <div className="card list">
        <p className="help list-help">Press lap on your watch each time you change the grade, then add the grades here. The plan counts the climbing and descent.</p>
        {candidates.map((r) => (
          <div key={r.id}>
            <div className="list-row">
              <span>
                {r.name}
                <span className="num muted course-list__facts">
                  {" "}
                  · {new Date(r.date!).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {(r.distanceKm ?? 0).toFixed(1)} km
                  {r.treadmillLaps && ` · ${Math.round(climbOf(r.treadmillLaps))} m up`}
                </span>
              </span>
              <button type="button" className="button-ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                {open === r.id ? "Close" : r.treadmillLaps ? "Edit grades" : "Add grades"}
              </button>
            </div>
            {open === r.id && (
              <LapGrades
                run={r}
                onSaved={() => {
                  setOpen(null);
                  onSaved();
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function climbOf(laps: TreadmillLap[]): number {
  return laps.reduce((a, l) => a + Math.max(0, (l.distanceM * l.gradePct) / 100 / Math.sqrt(1 + (l.gradePct / 100) ** 2)), 0);
}

function LapGrades({ run, onSaved }: { run: StoredRun; onSaved: () => void }) {
  const [laps, setLaps] = useState<{ distanceM: number; movingS: number; grade: string }[] | null>(
    run.treadmillLaps?.map((l) => ({ distanceM: l.distanceM, movingS: l.movingS, grade: String(l.gradePct) })) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!laps) {
    return (
      <div className="lap-grades">
        {error && <p className="help danger">{error}</p>}
        <button
          type="button"
          className="button-ghost"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            fetchStravaLaps(run.stravaId!)
              .then((ls) => setLaps(ls.map((l) => ({ ...l, grade: "" }))))
              .catch((e: Error) => setError(e.message))
              .finally(() => setLoading(false));
          }}
        >
          {loading ? "Getting laps…" : "Get laps from Strava"}
        </button>
      </div>
    );
  }

  const parsed = laps.map((l) => (l.grade.trim() === "" ? 0 : Number(l.grade.replace(",", "."))));
  const valid = parsed.every((g) => Number.isFinite(g) && g >= -40 && g <= 40);
  return (
    <form
      className="lap-grades"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const saved = laps.map((l, i) => ({ distanceM: l.distanceM, movingS: l.movingS, gradePct: parsed[i] }));
        void setStoredRunTreadmillLaps(run.id, saved).then(onSaved);
      }}
    >
      {laps.length <= 1 && <p className="help">Strava has one lap for this run. Its grade applies to the whole run.</p>}
      {laps.map((l, i) => (
        <label key={i} className="form-row">
          <span className="num">
            Lap {i + 1} · {(l.distanceM / 1000).toFixed(2)} km · {lapTime(l.movingS)}
          </span>
          <span className="input-unit">
            <input
              inputMode="decimal"
              placeholder="0"
              value={l.grade}
              aria-label={`Lap ${i + 1} grade, %`}
              onChange={(e) => setLaps(laps.map((x, j) => (j === i ? { ...x, grade: e.target.value } : x)))}
            />
            %
          </span>
        </label>
      ))}
      {!valid && <p className="help danger">Grades between −40 and 40%.</p>}
      <p className="help num">About {Math.round(climbOf(laps.map((l, i) => ({ ...l, gradePct: valid ? parsed[i] : 0 }))))} m up. Leave a lap empty for flat.</p>
      <button type="submit" className="button-primary" disabled={!valid}>
        Save grades
      </button>
    </form>
  );
}
