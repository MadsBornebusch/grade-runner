import { useEffect, useState } from "react";
import type { GpxPoint } from "../gpx/pipeline";
import { deleteStoredCourse, listStoredCourses, type StoredCourse } from "../storage/courseLibrary";

interface CourseLibraryPanelProps {
  onSelect: (points: GpxPoint[], name: string) => void;
  /** Bump to force a reload after a new course is saved elsewhere (a fresh
   * upload/import) -- this panel doesn't own the save itself, since App.tsx
   * already has the points/name in hand right where the upload/import
   * callbacks fire. */
  refreshKey: number;
}

export function CourseLibraryPanel({ onSelect, refreshKey }: CourseLibraryPanelProps) {
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
          <div key={c.id} className="course-library__row">
            <button type="button" className="course-library__select" onClick={() => onSelect(c.points, c.name)}>
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
