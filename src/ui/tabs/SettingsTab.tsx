import type { ReactNode } from "react";
import { AthleteFields } from "../InputsPanel";
import type { FormInputs } from "../formInputs";
import { useInstallPrompt } from "../../pwa/installPrompt";

interface SettingsTabProps {
  formInputs: FormInputs;
  onChange: (values: FormInputs) => void;
  /** Plan settings (strength, check-ins, re-plan), rendered by the caller. */
  planSection?: ReactNode;
}

/** Athlete setup (body mass, VO2max, thresholds, walking) and plan
 * settings. Strava and the run library live on the Runs tab. */
export function SettingsTab({ formInputs, onChange, planSection }: SettingsTabProps) {
  const install = useInstallPrompt();
  return (
    <div className="settings-page">
      <h1 className="screen-title">Settings</h1>
      <AthleteFields values={formInputs} onChange={onChange} />
      {planSection}
      {install && (
        <section>
          <h3 className="section-title">App</h3>
          <div className="card">
            <p className="help">Install Grade Runner to open it from your home screen, full screen and without the browser bar. It works offline with what's already on this device.</p>
            <div className="sheet__actions">
              <button type="button" className="button-primary" onClick={install}>
                Install app
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
