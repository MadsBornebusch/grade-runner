import { useEffect, useState } from "react";
import { CaretRight, FlagCheckered, MapTrifold, Plus, Trash } from "@phosphor-icons/react";
import { deleteStoredCourse, listStoredCourses, type StoredCourse } from "../storage/courseLibrary";
import { planSettingsStore } from "../storage/planSettings";

interface CourseLibraryPanelProps {
  /** Opens a course in the race plan (Pacing). Passes the full stored
   * course: the caller needs its id and saved checkpoints/target time. */
  onSelect: (course: StoredCourse) => void;
  onAdd: () => void;
  /** Bump to reload after a course is saved elsewhere. */
  refreshKey: number;
}

/** Your saved courses: tap one for its race plan. The goal race is
 * marked; deleting asks first. */
export function CourseLibraryPanel({ onSelect, onAdd, refreshKey }: CourseLibraryPanelProps) {
  const [courses, setCourses] = useState<StoredCourse[] | null>(null);
  const goalCourseId = planSettingsStore.use().goalRace?.courseId;

  useEffect(() => {
    void listStoredCourses().then(setCourses);
  }, [refreshKey]);

  const handleDelete = async (course: StoredCourse) => {
    const goal = course.id === goalCourseId ? " It's your goal race; the plan keeps its saved numbers." : "";
    if (!window.confirm(`Delete ${course.name}?${goal}`)) return;
    await deleteStoredCourse(course.id);
    setCourses((prev) => prev?.filter((c) => c.id !== course.id) ?? null);
  };

  return (
    <section>
      <h3 className="section-title">Your courses</h3>
      <div className="card list course-list">
        {courses?.map((c) => (
          <div key={c.id} className="course-list__row">
            <button type="button" className="list-row" onClick={() => onSelect(c)}>
              {c.id === goalCourseId ? <FlagCheckered size={20} weight="duotone" className="brand-ink" /> : <MapTrifold size={20} weight="duotone" className="muted" />}
              <span>
                <span className="course-list__name">{c.name}</span>
                <span className="num muted course-list__facts">
                  {(c.distanceM / 1000).toFixed(1)} km · {Math.round(c.elevationGainM).toLocaleString()} m
                  {c.id === goalCourseId && " · goal race"}
                </span>
              </span>
              <CaretRight size={16} />
            </button>
            <button type="button" className="icon-button course-list__delete" onClick={() => void handleDelete(c)} aria-label={`Delete ${c.name}`}>
              <Trash size={18} />
            </button>
          </div>
        ))}
        <button type="button" className="list-row course-list__add" onClick={onAdd}>
          <Plus size={20} />
          <span>Add a course</span>
        </button>
      </div>
    </section>
  );
}
