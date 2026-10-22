import type { SurfaceCategory } from "../../gpx/pipeline";
import type { DescentCapCurve } from "../../model/minetti";
import type { PacingMarginFitResult } from "../../model/pacingMarginFit";
import { RunLibraryPanel } from "../RunLibraryPanel";
import { StravaConnectionStatus } from "../StravaConnectionStatus";
import type { FormInputs, Vo2MaxEntry } from "../formInputs";

interface RunsTabProps {
  formInputs: FormInputs;
  onApplySurfaceCostMultipliers: (multipliers: Partial<Record<SurfaceCategory, number>>) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onApplyPacingMargin: (fit: PacingMarginFitResult) => void;
  onApplyDescentCapCurve: (curve: DescentCapCurve) => void;
  onApplyDurationCeiling: (fraction60Min: number, exponent: number) => void;
  onApplyAnaerobicCapacityMin: (anaerobicCapacityMin: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
}

/**
 * Strava, the run library and what the model learns from it. It stays
 * mounted (hidden) after the first visit, so RunLibraryPanel's in-flight
 * UI state survives a tab switch.
 */
export function RunsTab({ formInputs, ...apply }: RunsTabProps) {
  return (
    <div className="settings-page">
      <h1 className="screen-title">Runs</h1>
      <StravaConnectionStatus />
      <RunLibraryPanel formInputs={formInputs} {...apply} />
    </div>
  );
}
