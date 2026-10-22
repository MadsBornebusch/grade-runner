import { useState } from "react";
import type { GpxPoint, PipelineResult, RawCourseStats } from "../gpx/pipeline";
import { createFlatCourse } from "../gpx/genericCourse";
import { CourseDebugChart, type ProcessedDebugPoint } from "./CourseDebugChart";
import { CourseProcessingFields } from "./InputsPanel";
import { GpxUpload } from "./GpxUpload";
import { StravaImport } from "./StravaImport";
import type { FormInputs } from "./formInputs";
import { Sheet } from "./plan/Sheet";

/** Plain distance-in, flat-course-out form -- the third "add course" source
 * alongside GPX upload and Strava import, for planning against a generic
 * flat race with no real route to hand. Local-only state (the distance
 * input); the moment you actually create a course it's handed up through
 * the SAME onCourseLoaded contract GpxUpload/StravaImport already use. */
function GenericCourseForm({ onCreate }: { onCreate: (points: GpxPoint[], name: string) => void }) {
  const [distanceKm, setDistanceKm] = useState("10");

  const parsed = Number(distanceKm);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <div className="generic-course">
      <label className="generic-course__control">
        <div className="generic-course__row">
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={distanceKm}
            onChange={(e) => setDistanceKm(e.target.value)}
            aria-label="Distance, km"
          />
          <span>km</span>
          <button
            type="button"
            className="button-ghost"
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              onCreate(createFlatCourse(parsed), `Flat ${parsed}km course`);
            }}
          >
            Create
          </button>
        </div>
      </label>
    </div>
  );
}

interface AddCoursePanelProps {
  open: boolean;
  onClose: () => void;
  onCourseLoaded: (points: GpxPoint[], name: string, stravaId?: number) => void;
  formInputs: FormInputs;
  onFormInputsChange: (values: FormInputs) => void;
  courseResult: PipelineResult | null;
  fileName: string | null;
  rawStats: RawCourseStats | null;
  debugProcessedPoints: ProcessedDebugPoint[];
}

/**
 * Everything to do with getting a course loaded, in one sheet: the three
 * sources (GPX upload, Strava import, a flat distance), then the loaded
 * course's stats. Processing settings and the debug chart sit under Lab.
 */
export function AddCoursePanel({
  open,
  onClose,
  onCourseLoaded,
  formInputs,
  onFormInputsChange,
  courseResult,
  fileName,
  rawStats,
  debugProcessedPoints,
}: AddCoursePanelProps) {
  if (!open) return null;
  return (
    <Sheet title="Add course" onClose={onClose}>
      <div className="add-course">
        <section className="add-course__source">
          <h3>From a GPX file</h3>
          <GpxUpload onLoaded={(points, name) => onCourseLoaded(points, name)} />
        </section>
        <section className="add-course__source">
          <h3>From Strava</h3>
          <StravaImport onImport={(points, name, stravaId) => onCourseLoaded(points, name, stravaId)} />
        </section>
        <section className="add-course__source">
          <h3>A flat distance</h3>
          <GenericCourseForm onCreate={(points, name) => onCourseLoaded(points, name)} />
        </section>
        {courseResult && (
          <section className="add-course__loaded">
            {fileName && <p className="add-course__name">{fileName}</p>}
            <p className="num muted">
              {(courseResult.totalDistance3D / 1000).toFixed(1)} km · {courseResult.totalElevationGain.toFixed(0)} m up
            </p>
            {!courseResult.hasElevation && <p className="help">No elevation in this file, so the course counts as flat.</p>}
            <details className="lab">
              <summary>Lab: course processing</summary>
              <CourseProcessingFields values={formInputs} onChange={onFormInputsChange} />
              {formInputs.showCourseDebug && rawStats && (
                <CourseDebugChart
                  raw={rawStats}
                  processed={debugProcessedPoints}
                  processedDistanceM={courseResult.totalDistance3D}
                  processedElevationGain={courseResult.totalElevationGain}
                  segmentLengthM={formInputs.segmentLengthM}
                  smoothingWindowM={formInputs.smoothingWindowM}
                />
              )}
            </details>
          </section>
        )}
      </div>
    </Sheet>
  );
}
