import type { ReactNode } from "react";
import { AthleteFields } from "../InputsPanel";
import type { FormInputs } from "../formInputs";

interface SettingsTabProps {
  formInputs: FormInputs;
  onChange: (values: FormInputs) => void;
  /** Plan settings (strength, check-ins, re-plan), rendered by the caller. */
  planSection?: ReactNode;
}

/** Athlete setup (body mass, VO2max, thresholds, walking) and plan
 * settings. Strava and the run library live on the Runs tab. */
export function SettingsTab({ formInputs, onChange, planSection }: SettingsTabProps) {
  return (
    <div className="settings-page">
      <h1 className="screen-title">Settings</h1>
      <AthleteFields values={formInputs} onChange={onChange} />
      {planSection}
    </div>
  );
}
