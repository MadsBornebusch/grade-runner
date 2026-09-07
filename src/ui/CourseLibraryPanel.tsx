import { useEffect, useState } from "react";
import { deleteStoredCourse, listStoredCourses, type StoredCourse } from "../storage/courseLibrary";

interface CourseLibraryPanelProps {
  /** Passes the FULL stored course, not just points/name -- App.tsx needs
   * its id (to know which row to write future checkpoint/target-time
   * changes back to) and its saved savedPointsKm/targetTimeS to restore
   * them. */
  onSelect: (course: StoredCourse) => void;
  /** Id of the course currently loaded into the plan, so the list can show
   * which one you're looking at. Null when none is loaded (a fresh upload
   * that hasn't been saved, or nothing selected yet). */
  selectedCourseId: string | null;
  /** Bump to force a reload after a new course is saved elsewhere (a fresh
   * upload/import) -- this panel doesn't own the save itself, since App.tsx
   * already has the points/name in hand right where the upload/import
   * callbacks fire. */
  refreshKey: number;
}

export function CourseLibraryPanel({ onSelect, selectedCourseId, refreshKey }: CourseLibraryPanelProps) {
  const [courses, setCourses] = useState<StoredCourse[] | null>(null);

  useEffect(() => {
    void listStoredCourses().then(setCourses);
  }, [refreshKey]);

  const handleDelete = async (id: string) => {
    await deleteStoredCourse(id);
    setCourses((prev) => prev?.filter((c) => c.id !== id) ?? null);
  };

  if (!courses || courses.length === 0) return null;

  return (
    <div className="course-library">
      <h3>Saved courses</h3>
      <div className="course-library__rows">
        {courses.map((c) => (
          <div
            key={c.id}
            className={`course-library__row${c.id === selectedCourseId ? " course-library__row--selected" : ""}`}
          >
            <button
              type="button"
              className="course-library__select"
              onClick={() => onSelect(c)}
              // Communicates the selection to assistive tech too, not just
              // to the eye -- the visual treatment alone isn't reachable
              // for a screen-reader user.
              aria-current={c.id === selectedCourseId ? "true" : undefined}
            >
              {c.id === selectedCourseId && <span className="course-library__selected-tick">✓</span>}
              {c.name} &middot; {(c.distanceM / 1000).toFixed(1)} km &middot; {c.elevationGainM.toFixed(0)} m gain
            </button>
            <button
              type="button"
              className="course-library__delete"
              onClick={() => void handleDelete(c.id)}
              aria-label={`Delete ${c.name}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
