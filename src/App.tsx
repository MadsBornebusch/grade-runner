import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { TabBar } from "./ui/TabBar";
import { RaceTab } from "./ui/tabs/RaceTab";
import { SettingsTab } from "./ui/tabs/SettingsTab";
import { RunsTab } from "./ui/tabs/RunsTab";
import { loadFormInputs, saveFormInputs, type FormInputs, type Vo2MaxEntry } from "./ui/formInputs";
import { useStravaSession } from "./ui/useStravaSession";
import { getRunFitStatus, subscribeToRunFit } from "./ui/runFitBatch";
import { useHashRoute, type TabId } from "./ui/useHashRoute";
import { usePlan } from "./ui/usePlan";
import { syncOnOpen } from "./ui/syncOnOpen";
import { refreshModel } from "./ui/modelRefresh";
import type { RunFitCallbacks } from "./ui/runFitBatch";
import { TodayTab } from "./ui/tabs/TodayTab";
import { ScheduleTab } from "./ui/tabs/ScheduleTab";
import { PlanSettingsSection } from "./ui/plan/PlanSettingsSection";
import { ProgressView } from "./ui/plan/ProgressView";
import "./styles/shell.css";
import "./styles/plan.css";

function App() {
  const route = useHashRoute("today");
  const [formInputs, setFormInputs] = useState(() => loadFormInputs());
  const { connected: stravaConnected } = useStravaSession();
  // Re-predicting the race is a long solve: not while typing in Settings.
  const plan = usePlan(formInputs, route.tab === "settings");
  const formInputsRef = useRef(formInputs);
  formInputsRef.current = formInputs;
  // Where the fits land. setFormInputs is stable, so this is built once.
  const applyFit = useMemo<RunFitCallbacks>(
    () => ({
      onApplySurfaceCostMultipliers: (surfaceCostMultipliers) => setFormInputs((prev) => ({ ...prev, surfaceCostMultipliers })),
      onApplyDescentCapCurve: (descentCapCurve) => setFormInputs((prev) => ({ ...prev, descentCapCurve })),
      // Switching to powerLaw here is the point: the fit only runs on
      // confirmed races and only applies above its support gates, so a
      // non-defaults result IS the evidence that this athlete's own curve
      // is better than the exponential default.
      onApplyDurationCeiling: (powerLawFraction60Min, powerLawExponent) => setFormInputs((prev) => ({ ...prev, powerLawFraction60Min, powerLawExponent })),
      onApplyAnaerobicCapacityMin: (anaerobicCapacityMin) => setFormInputs((prev) => ({ ...prev, anaerobicCapacityMin })),
      onApplyHrCalibration: (hrPowerCalibrationSlope, hrPowerCalibrationIntercept) =>
        setFormInputs((prev) => ({ ...prev, hrPowerCalibrationSlope, hrPowerCalibrationIntercept })),
      onApplyPacingMargin: (fit) =>
        setFormInputs((prev) => ({
          ...prev,
          pacingMargin: { marginFInf: fit.marginFInf, marginTauHours: fit.marginTauHours, bestUpsideOffset: fit.bestUpsideOffset },
        })),
    }),
    [],
  );
  // The settings pull on connect (below) has to land first: a fit applied
  // before it would be overwritten by the server copy, and the stale
  // values pushed back.
  const [settingsPulled, setSettingsPulled] = useState(false);
  useEffect(() => {
    if (!stravaConnected || !settingsPulled) return;
    void syncOnOpen().then(() => refreshModel(() => formInputsRef.current, applyFit));
  }, [stravaConnected, settingsPulled, applyFit]);
  // Runs (with the run library's heavy fit memos) mounts on its first
  // visit and stays mounted after, so it doesn't slow every app open.
  const [runsVisited, setRunsVisited] = useState(false);
  useEffect(() => {
    if (route.tab === "runs") setRunsVisited(true);
  }, [route.tab]);

  // Fit runs as a module-level process (runFitBatch.ts), independent of
  // whether the Runs tab is showing -- see that file's own doc. Fits now
  // run on their own after a sync, so the Runs tab only gets a badge when
  // one failed while another tab was showing.
  const runFitStatus = useSyncExternalStore(subscribeToRunFit, getRunFitStatus);
  const [hasUnseenFitError, setHasUnseenFitError] = useState(false);
  const wasFitRunningRef = useRef(runFitStatus.running);
  const runsShowing = route.tab === "runs";
  useEffect(() => {
    const justFinished = wasFitRunningRef.current && !runFitStatus.running && runFitStatus.error;
    wasFitRunningRef.current = runFitStatus.running;
    if (justFinished && !runsShowing) setHasUnseenFitError(true);
  }, [runFitStatus, runsShowing]);
  useEffect(() => {
    if (runsShowing) setHasUnseenFitError(false);
  }, [runsShowing]);

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
      .catch(() => {})
      .finally(() => setSettingsPulled(true));
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

  // #/<tab>/progress: the Progress page, over whichever tab opened it, so
  // that tab stays lit and Back returns to it.
  const progress = route.rest[0] === "progress";
  const show = (tab: TabId) => ({ hidden: progress || route.tab !== tab, className: `tab-page tab-page--${tab}` });

  return (
    <div className="app-shell">
      <TabBar
        active={route.tab}
        onSelect={(tab) => route.navigate(tab)}
        badges={hasUnseenFitError ? { runs: "updating your model failed" } : {}}
      />
      <main className="app-main">
        <div {...show("today")}>
          {route.tab === "today" && !progress && <TodayTab plan={plan} formInputs={formInputs} navigate={route.navigate} />}
        </div>
        <div {...show("schedule")}>
          {route.tab === "schedule" && !progress && <ScheduleTab plan={plan} formInputs={formInputs} rest={route.rest} navigate={route.navigate} />}
        </div>
        <div {...show("race")}>
          <RaceTab
            formInputs={formInputs}
            setFormInputs={setFormInputs}
            active={route.tab === "race" && !progress}
            rest={route.tab === "race" && !progress ? route.rest : null}
            navigate={route.navigate}
            plan={plan}
          />
        </div>
        {progress && (
          <div className="tab-page tab-page--progress">
            <ProgressView plan={plan} formInputs={formInputs} onBack={() => route.navigate(route.tab)} />
          </div>
        )}
        <div {...show("runs")}>
          {(runsVisited || route.tab === "runs") && (
            <RunsTab
              formInputs={formInputs}
              {...applyFit}
              onAddVo2MaxEntry={(entry: Vo2MaxEntry) => setFormInputs((prev) => ({ ...prev, vo2MaxHistory: [...prev.vo2MaxHistory, entry] }))}
            />
          )}
        </div>
        <div {...show("settings")}>
          <SettingsTab
            formInputs={formInputs}
            onChange={setFormInputs}
            planSection={<PlanSettingsSection plan={plan} formInputs={formInputs} />}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
