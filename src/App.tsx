import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TabBar } from "./ui/TabBar";
import { RaceTab } from "./ui/tabs/RaceTab";
import { RACE_SEGMENTS, type RaceSegment } from "./ui/tabs/raceSegments";
import { SettingsTab } from "./ui/tabs/SettingsTab";
import { loadFormInputs, saveFormInputs, type FormInputs, type Vo2MaxEntry } from "./ui/formInputs";
import { useStravaSession } from "./ui/useStravaSession";
import { getRunFitStatus, subscribeToRunFit } from "./ui/runFitBatch";
import { useHashRoute, type TabId } from "./ui/useHashRoute";
import "./App.css";
import "./styles/shell.css";

function App() {
  const route = useHashRoute("race");
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());
  const { connected: stravaConnected } = useStravaSession();

  // Fit runs as a module-level process (runFitBatch.ts), independent of
  // whether the Settings tab is showing -- see that file's own doc. This
  // just surfaces a badge on the Settings tab when a fit finished (success
  // or error) while another tab was showing, so leaving Settings to do
  // something else doesn't mean losing track of when the result lands.
  const runFitStatus = useSyncExternalStore(subscribeToRunFit, getRunFitStatus);
  const [hasUnseenFitResult, setHasUnseenFitResult] = useState(false);
  const wasFitRunningRef = useRef(runFitStatus.running);
  const settingsShowing = route.tab === "settings";
  useEffect(() => {
    const justFinished = wasFitRunningRef.current && !runFitStatus.running && (runFitStatus.result || runFitStatus.error);
    wasFitRunningRef.current = runFitStatus.running;
    if (justFinished && !settingsShowing) setHasUnseenFitResult(true);
  }, [runFitStatus, settingsShowing]);
  useEffect(() => {
    if (settingsShowing) setHasUnseenFitResult(false);
  }, [settingsShowing]);

  useEffect(() => {
    saveFormInputs(formInputs);
  }, [formInputs]);

  // Cross-device settings sync, gated on being Strava-connected: pull any
  // previously-saved settings once on connect (overriding this browser's
  // localStorage), then push local changes back up, debounced so typing in
  // a number field doesn't fire a request per keystroke.
  useEffect(() => {
    if (!stravaConnected) return;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { settings: Partial<FormInputs> | null } | null) => {
        if (body?.settings) setFormInputs((prev) => ({ ...prev, ...body.settings }));
      })
      .catch(() => {});
  }, [stravaConnected]);

  useEffect(() => {
    if (!stravaConnected) return;
    const timeout = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formInputs),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timeout);
  }, [stravaConnected, formInputs]);

  const raceSegment: RaceSegment = RACE_SEGMENTS.find((s) => s.id === route.rest[0])?.id ?? "course";
  const show = (tab: TabId) => ({ hidden: route.tab !== tab, className: `tab-page tab-page--${tab}` });

  return (
    <div className="app-shell">
      <TabBar
        active={route.tab}
        onSelect={(tab) => route.navigate(tab)}
        badges={hasUnseenFitResult ? { settings: "your fit result is ready" } : {}}
      />
      <main className="app-main">
        <div {...show("today")}>
          <h1 className="screen-title">Today</h1>
          <p className="placeholder">Your training plan shows here once a goal race is set.</p>
        </div>
        <div {...show("schedule")}>
          <h1 className="screen-title">Schedule</h1>
          <p className="placeholder">Your weekly schedule shows here once a goal race is set.</p>
        </div>
        <div {...show("race")}>
          <RaceTab
            formInputs={formInputs}
            setFormInputs={setFormInputs}
            active={route.tab === "race"}
            segment={raceSegment}
            onSegmentChange={(segment) => route.navigate("race", segment)}
          />
        </div>
        <div {...show("settings")}>
          <SettingsTab
            formInputs={formInputs}
            onChange={setFormInputs}
            onApplySurfaceCostMultipliers={(surfaceCostMultipliers) => setFormInputs((prev) => ({ ...prev, surfaceCostMultipliers }))}
            onApplyDescentCapCurve={(descentCapCurve) => setFormInputs((prev) => ({ ...prev, descentCapCurve }))}
            onApplyDurationCeiling={(powerLawFraction60Min, powerLawExponent) =>
              // Switching to powerLaw here is the point: the fit only runs on
              // confirmed races and only applies above its support gates, so a
              // non-defaults result IS the evidence that this athlete's own
              // curve is better than the exponential default.
              setFormInputs((prev) => ({ ...prev, powerLawFraction60Min, powerLawExponent }))
            }
            onApplyAnaerobicCapacityMin={(anaerobicCapacityMin) => setFormInputs((prev) => ({ ...prev, anaerobicCapacityMin }))}
            onApplyHrCalibration={(hrPowerCalibrationSlope, hrPowerCalibrationIntercept) =>
              setFormInputs((prev) => ({ ...prev, hrPowerCalibrationSlope, hrPowerCalibrationIntercept }))
            }
            onApplyPacingMargin={(fit) =>
              setFormInputs((prev) => ({
                ...prev,
                pacingMargin: { marginFInf: fit.marginFInf, marginTauHours: fit.marginTauHours, bestUpsideOffset: fit.bestUpsideOffset },
              }))
            }
            onAddVo2MaxEntry={(entry: Vo2MaxEntry) => setFormInputs((prev) => ({ ...prev, vo2MaxHistory: [...prev.vo2MaxHistory, entry] }))}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
