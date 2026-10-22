import type { ReactNode } from "react";
import type { SurfaceCategory } from "../../gpx/pipeline";
import type { PacingMarginFitResult } from "../../model/pacingMarginFit";
import type { DescentCapCurve } from "../../model/minetti";
import { AthleteFields } from "../InputsPanel";
import { RunLibraryPanel } from "../RunLibraryPanel";
import { StravaConnectionStatus } from "../StravaConnectionStatus";
import type { FormInputs, Vo2MaxEntry } from "../formInputs";

interface SettingsTabProps {
  formInputs: FormInputs;
  onChange: (values: FormInputs) => void;
  onApplySurfaceCostMultipliers: (multipliers: Partial<Record<SurfaceCategory, number>>) => void;
  onApplyHrCalibration: (slope: number, intercept: number) => void;
  onApplyPacingMargin: (fit: PacingMarginFitResult) => void;
  onApplyDescentCapCurve: (curve: DescentCapCurve) => void;
  onApplyDurationCeiling: (fraction60Min: number, exponent: number) => void;
  onApplyAnaerobicCapacityMin: (anaerobicCapacityMin: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
  /** Plan settings (strength, check-ins, re-plan), rendered by the caller. */
  planSection?: ReactNode;
}

/**
 * Athlete setup: body mass/VO2max/walk speed/LT1-LT2/pacing curve, the
 * Strava connect+backfill+fit flow (RunLibraryPanel) and plan settings.
 * A tab now rather than an overlay; it stays mounted (hidden) while other
 * tabs show, so RunLibraryPanel's in-flight UI state survives a tab
 * switch.
 */
export function SettingsTab({
  formInputs,
  onChange,
  onApplySurfaceCostMultipliers,
  onApplyHrCalibration,
  onApplyPacingMargin,
  onApplyDescentCapCurve,
  onApplyDurationCeiling,
  onApplyAnaerobicCapacityMin,
  onAddVo2MaxEntry,
  planSection,
}: SettingsTabProps) {
  return (
    <div className="settings-page">
      <h1 className="screen-title">Settings</h1>
      <AthleteFields values={formInputs} onChange={onChange} />
      <StravaConnectionStatus />
      {planSection}
      <RunLibraryPanel
        formInputs={formInputs}
        onApplySurfaceCostMultipliers={onApplySurfaceCostMultipliers}
        onApplyHrCalibration={onApplyHrCalibration}
        onApplyPacingMargin={onApplyPacingMargin}
        onApplyDescentCapCurve={onApplyDescentCapCurve}
        onApplyDurationCeiling={onApplyDurationCeiling}
        onApplyAnaerobicCapacityMin={onApplyAnaerobicCapacityMin}
        onAddVo2MaxEntry={onAddVo2MaxEntry}
      />
    </div>
  );
}
