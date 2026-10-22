import { useEffect, useState } from "react";
import { ArrowRight, FlagCheckered, PencilSimple, Ruler, Timer, TrendDown } from "@phosphor-icons/react";
import { demonstratedIntake } from "../../plan/carbLadder";
import { dayNumberOf } from "../../plan/historyFromRuns";
import { listStoredCourses, type StoredCourse } from "../../storage/courseLibrary";
import { fuelLogStore } from "../../storage/fuelLogs";
import { planSettingsStore } from "../../storage/planSettings";
import { runPipeline } from "../../gpx/pipeline";
import { formatDuration, parseDurationToSeconds } from "../format";
import type { FormInputs } from "../formInputs";
import { predictFinishS } from "../solverInputs";
import { TIME_ZONE, type PlanState } from "../usePlan";
import { localDateKey } from "../../plan/loadLedger";
import { shortDate } from "./planCopy";

interface GoalRaceCardProps {
  formInputs: FormInputs;
  plan: PlanState;
  /** Bumped when a course is added, to refresh the picker. */
  refreshKey: number;
  onOpenPacing: (course: StoredCourse) => void;
}

export function GoalRaceCard({ formInputs, plan, refreshKey, onOpenPacing }: GoalRaceCardProps) {
  const settings = planSettingsStore.use();
  const race = settings.goalRace;
  const [courses, setCourses] = useState<StoredCourse[]>([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    void listStoredCourses().then(setCourses);
  }, [refreshKey]);

  if (!race || editing) {
    return <GoalRaceForm courses={courses} initial={race} onDone={() => setEditing(false)} canCancel={!!race} />;
  }

  const daysToGo = dayNumberOf(race.date) - plan.today;
  const course = courses.find((c) => c.id === race.courseId);
  return (
    <div className="race-hero">
      <span className="overline race-hero__date">{new Date(`${race.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>
      <div className="race-hero__top">
        <h2>{race.name}</h2>
        {daysToGo >= 0 && (
          <div className="race-hero__countdown">
            <span className="num">{daysToGo}</span>
            <span>days to go</span>
          </div>
        )}
      </div>
      <div className="race-hero__meta num">
        <span>
          <Ruler size={16} /> {race.distanceKm.toFixed(0)} km
        </span>
        {race.descentM !== null && (
          <span>
            <TrendDown size={16} /> {Math.round(race.descentM).toLocaleString()} m down
            {race.steepDescentM ? `, ${Math.round(race.steepDescentM)} m steep` : ""}
          </span>
        )}
      </div>
      <Prediction formInputs={formInputs} plan={plan} course={course} />
      <div className="race-hero__actions">
        {course && (
          <button type="button" className="button-on-dark" onClick={() => onOpenPacing(course)}>
            Race plan <ArrowRight size={16} />
          </button>
        )}
        <button type="button" className="button-on-dark button-on-dark--ghost" onClick={() => setEditing(true)}>
          <PencilSimple size={16} /> Change race
        </button>
      </div>
    </div>
  );
}

function Prediction({ formInputs, plan, course }: { formInputs: FormInputs; plan: PlanState; course?: StoredCourse }) {
  const race = planSettingsStore.use().goalRace!;
  const logs = fuelLogStore.use().byRunId;
  const [overrideText, setOverrideText] = useState<string | null>(null);
  const trained = plan.history
    ? demonstratedIntake(plan.history.map((r) => ({ runId: r.runId, day: r.day, movingMin: r.movingMin })), logs, plan.today)
    : null;
  const assumed = formInputs.intakeGPerH;

  // The finish at the trained intake: a second solve, off the first paint.
  const [atTrained, setAtTrained] = useState<{ key: string; s: number | null } | null>(null);
  const trainedKey = `${race.predictionKey}:${trained}`;
  useEffect(() => {
    if (!course || trained === null || trained >= assumed || atTrained?.key === trainedKey) return;
    const timer = setTimeout(() => {
      const result = runPipeline(course.points, { segmentLengthM: formInputs.segmentLengthM, smoothingWindowM: formInputs.smoothingWindowM });
      setAtTrained({ key: trainedKey, s: predictFinishS(result.segments, formInputs, trained) });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course, trainedKey, assumed]);

  const predicted = race.predictedFinishS;
  const used = race.expectedHoursOverride ? race.expectedHoursOverride * 3600 : predicted;
  return (
    <div className="race-hero__panel">
      <div className="race-hero__finish">
        <span className="overline">
          <Timer size={14} /> {race.expectedHoursOverride ? "Your expected finish" : formInputs.pacingMargin ? "Predicted finish" : "Best-case finish"}
        </span>
        {overrideText === null ? (
          <button type="button" className="race-hero__time num" onClick={() => setOverrideText(used ? formatDuration(used).slice(0, -3) : "")} title="Change">
            {used ? formatDuration(used).slice(0, -3) : plan.predicting ? "…" : "–"}
          </button>
        ) : (
          <form
            className="race-hero__override"
            onSubmit={(e) => {
              e.preventDefault();
              const s = parseDurationToSeconds(overrideText);
              planSettingsStore.set((st) => ({ ...st, goalRace: st.goalRace && { ...st.goalRace, expectedHoursOverride: s ? s / 3600 : null } }));
              setOverrideText(null);
            }}
          >
            <input autoFocus inputMode="numeric" placeholder="H:MM" value={overrideText} onChange={(e) => setOverrideText(e.target.value)} aria-label="Expected finish, H:MM" />
            <button type="submit" className="button-on-dark">
              Save
            </button>
          </form>
        )}
      </div>
      <p className="race-hero__note">
        {race.expectedHoursOverride && predicted
          ? `Plan uses your time. Prediction from your fitness today: ${formatDuration(predicted).slice(0, -3)}.`
          : formInputs.pacingMargin
            ? "From your fitness today and how you pace races. Sizes your long runs; tap to use your own time."
            : "Your ceiling: a perfect day. Confirm 4 or more races on Runs for a realistic prediction, or tap to use your own time."}
        {race.expectedHoursOverride && (
          <button
            type="button"
            className="link-button link-button--on-dark"
            onClick={() => planSettingsStore.set((st) => ({ ...st, goalRace: st.goalRace && { ...st.goalRace, expectedHoursOverride: null } }))}
          >
            Use prediction
          </button>
        )}
      </p>
      <p className="race-hero__note">
        Assumes {assumed} g/h of carbs.{" "}
        {trained === null
          ? "You haven't logged carbs on a long run yet."
          : trained >= assumed
            ? `You've trained ${trained} g/h.`
            : `You've trained up to ${trained} g/h.`}
        {trained !== null && trained < assumed && atTrained?.key === trainedKey && atTrained.s && predicted && (
          <>
            {" "}
            {atTrained.s - predicted < 60
              ? "No change to your finish time at that intake."
              : `At ${trained} g/h: about +${Math.round((atTrained.s - predicted) / 60)} min.`}
          </>
        )}
      </p>
    </div>
  );
}

function GoalRaceForm({ courses, initial, onDone, canCancel }: { courses: StoredCourse[]; initial: ReturnType<typeof planSettingsStore.get>["goalRace"]; onDone: () => void; canCancel: boolean }) {
  const [courseId, setCourseId] = useState(initial?.courseId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [date, setDate] = useState(initial?.date ?? "");
  const course = courses.find((c) => c.id === courseId);
  const todayIso = localDateKey(new Date(), TIME_ZONE);
  const valid = !!course && !!date && date >= todayIso;
  return (
    <form
      className="card goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!course) return;
        const sameCourse = initial?.courseId === course.id;
        planSettingsStore.set((s) => ({
          ...s,
          goalRace: {
            courseId: course.id,
            name: name.trim() || course.name,
            date,
            distanceKm: sameCourse && initial ? initial.distanceKm : course.distanceM / 1000,
            descentM: sameCourse && initial ? initial.descentM : null,
            steepDescentM: sameCourse && initial ? initial.steepDescentM : null,
            predictedFinishS: sameCourse && initial ? initial.predictedFinishS : null,
            predictionKey: sameCourse ? initial?.predictionKey : undefined,
            expectedHoursOverride: sameCourse && initial ? initial.expectedHoursOverride : null,
          },
          // Moves were for the old race's weeks.
          longRunMoves: sameCourse ? s.longRunMoves : {},
        }));
        onDone();
      }}
    >
      <h2 className="card-title">
        <FlagCheckered size={20} weight="duotone" /> Goal race
      </h2>
      {courses.length === 0 ? (
        <p className="help">Add the race course first (+ Add course below): a GPX file or a Strava route.</p>
      ) : (
        <>
          <label className="form-row">
            <span>Course</span>
            <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Choose a saved course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {(c.distanceM / 1000).toFixed(0)} km
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span>Name</span>
            <input type="text" value={name} placeholder={course?.name ?? "Race name"} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-row">
            <span>Date</span>
            <input type="date" value={date} min={todayIso} onChange={(e) => setDate(e.target.value)} />
          </label>
          {date && date < todayIso && <p className="help">Pick a date from today on.</p>}
          {date && <p className="help">{shortDate(dayNumberOf(date))}: your plan counts down to it.</p>}
        </>
      )}
      <div className="sheet__actions">
        <button type="submit" className="button-primary" disabled={!valid}>
          Set as goal race
        </button>
        {canCancel && (
          <button type="button" className="button-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
