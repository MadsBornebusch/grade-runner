import { useEffect, useRef } from "react";
import type { EffortTrendPoint } from "../model/pacingFit";
import { AthleteFields } from "./InputsPanel";
import { RunLibraryPanel } from "./RunLibraryPanel";
import { StravaConnectionStatus } from "./StravaConnectionStatus";
import type { FormInputs, Vo2MaxEntry } from "./formInputs";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  formInputs: FormInputs;
  onChange: (values: FormInputs) => void;
  onApplyTau: (tauMin: number) => void;
  onApplyFInf: (fInf: number) => void;
  onApplyUnpavedCostMultiplier: (unpavedCostMultiplier: number) => void;
  onAddVo2MaxEntry: (entry: Vo2MaxEntry) => void;
  onRacesFitted: (races: EffortTrendPoint[][], raceDates: (Date | null)[]) => void;
}

/**
 * One-time athlete setup, decoupled from the Course/Results swipeable flow
 * entirely -- body mass/VO2max/walk speed/LT1-LT2/pacing curve plus the
 * Strava connect+backfill+fit flow (RunLibraryPanel), all in an overlay
 * reached via a gear icon rather than a tab. Unmounts when closed (not just
 * hidden) -- RunLibraryPanel's own ephemeral UI state (in-flight fit,
 * errors, backfill progress) resetting on reopen is fine, since everything
 * that actually matters (stored runs, formInputs) persists independently.
 */
export function SettingsModal({
  open,
  onClose,
  formInputs,
  onChange,
  onApplyTau,
  onApplyFInf,
  onApplyUnpavedCostMultiplier,
  onAddVo2MaxEntry,
  onRacesFitted,
}: SettingsModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-modal__overlay" onClick={onClose}>
      <div
        className="settings-modal__card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal__header">
          <h2>Settings</h2>
          <button type="button" ref={closeButtonRef} className="settings-modal__close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>
        <div className="settings-modal__body">
          <AthleteFields values={formInputs} onChange={onChange} />
          <StravaConnectionStatus />
          <RunLibraryPanel
            formInputs={formInputs}
            onApplyTau={onApplyTau}
            onApplyFInf={onApplyFInf}
            onApplyUnpavedCostMultiplier={onApplyUnpavedCostMultiplier}
            onAddVo2MaxEntry={onAddVo2MaxEntry}
            onRacesFitted={onRacesFitted}
          />
        </div>
      </div>
    </div>
  );
}
