import { useEffect, useRef, useState } from "react";
import type { GpxPoint, PipelineResult, RawCourseStats } from "../gpx/pipeline";
import { createFlatCourse } from "../gpx/genericCourse";
import { CourseDebugChart, type ProcessedDebugPoint } from "./CourseDebugChart";
import { CourseProcessingFields } from "./InputsPanel";
import { GpxUpload } from "./GpxUpload";
import { StravaImport } from "./StravaImport";
import type { FormInputs } from "./formInputs";

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
        <span>Generic flat course</span>
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
            className="fatox-add"
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
 * Everything to do with GETTING a course loaded, in one card: the three
 * source options (GPX upload, Strava import, generic flat distance), plus
 * -- once a course is active -- its name/stats, processing settings, and
 * the raw-vs-processed debug chart. Mirrors SettingsModal's own shell
 * (overlay/card/header/body, unmounts when closed, Escape closes, focus
 * moves to the close button) for visual and behavioral consistency with
 * the one other modal this app has.
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="settings-modal__overlay" onClick={onClose}>
      <div
        className="settings-modal__card"
        role="dialog"
        aria-modal="true"
        aria-label="Add course"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal__header">
          <h2>Add course</h2>
          <button type="button" ref={closeButtonRef} className="settings-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="settings-modal__body">
          <GpxUpload onLoaded={(points, name) => onCourseLoaded(points, name)} />
          <StravaImport onImport={(points, name, stravaId) => onCourseLoaded(points, name, stravaId)} />
          <GenericCourseForm onCreate={(points, name) => onCourseLoaded(points, name)} />
          {courseResult && (
            <>
              {fileName && <p className="course-name">{fileName}</p>}
              {!courseResult.hasElevation && <p className="warning">No elevation data found — treating the course as flat.</p>}
              <p className="course-stats">
                {(courseResult.totalDistance3D / 1000).toFixed(1)} km &middot; {courseResult.totalElevationGain.toFixed(0)} m gain
              </p>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
