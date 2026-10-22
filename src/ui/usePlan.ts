import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildHistory } from "../plan/historyCache";
import { dayNumberOf, type DatedHistoryRun } from "../plan/historyFromRuns";
import { ladderStart } from "../plan/carbLadder";
import { needsReplan, planFromSettings, planInputsKey, type PlanBlocker, type PlanSnapshot } from "../plan/planFromSettings";
import { localDateKey } from "../plan/loadLedger";
import { listStoredCourses } from "../storage/courseLibrary";
import { createLocalStore } from "../storage/localStore";
import { fuelLogStore } from "../storage/fuelLogs";
import { planSettingsStore } from "../storage/planSettings";
import { listStoredRuns } from "../storage/runLibrary";
import { getAutoFetchStatus, subscribeToAutoFetch } from "./autoFetchRuns";
import { getBackfillStatus, subscribeToBackfill } from "./backfillRuns";
import type { FormInputs } from "./formInputs";
import { courseFacts, predictionKey } from "./goalRace";

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const todayDayNumber = () => dayNumberOf(localDateKey(new Date(), TIME_ZONE));

/** The last generated plan, kept through the week (planFromSettings.ts's
 * needsReplan decides when it's regenerated). */
export const planSnapshotStore = createLocalStore<{ version: 1; snapshot: PlanSnapshot | null }>("grade-runner.planSnapshot.v1", {
  version: 1,
  snapshot: null,
});

export interface PlanState {
  /** Null while the runs are loading. */
  history: DatedHistoryRun[] | null;
  /** Run names by StoredRun.id, for labelling past races. */
  runNames: Map<string, string>;
  /** Shown while uncached runs are processed. */
  progress: { done: number; total: number } | null;
  snapshot: PlanSnapshot | null;
  blocker: PlanBlocker | null;
  predicting: boolean;
  today: number;
  replanNow: () => void;
}

/** Runs -> history -> plan, re-planned only when planFromSettings.ts's
 * rule says so. Also keeps the goal race's cached prediction in step with
 * the athlete's settings. */
export function usePlan(formInputs: FormInputs): PlanState {
  const settings = planSettingsStore.use();
  const { snapshot } = planSnapshotStore.use();
  const logs = fuelLogStore.use().byRunId;
  const [history, setHistory] = useState<DatedHistoryRun[] | null>(null);
  const [runNames, setRunNames] = useState(new Map<string, string>());
  const [progress, setProgress] = useState<PlanState["progress"]>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [predicting, setPredicting] = useState(false);
  const today = todayDayNumber();

  // Reload the runs whenever a sync or points download finishes.
  const backfillRunning = useSyncExternalStore(subscribeToBackfill, getBackfillStatus).running;
  const autoFetchRunning = useSyncExternalStore(subscribeToAutoFetch, getAutoFetchStatus).running;
  const syncing = backfillRunning || autoFetchRunning;
  useEffect(() => {
    if (!syncing) setReloadKey((k) => k + 1);
  }, [syncing]);

  useEffect(() => {
    let cancelled = false;
    listStoredRuns()
      .then((runs) => {
        if (cancelled) return null;
        setRunNames(new Map(runs.map((r) => [r.id, r.name])));
        return buildHistory(runs, TIME_ZONE, (done, total) => !cancelled && setProgress({ done, total }));
      })
      .then((h) => {
        if (cancelled || !h) return;
        setHistory(h);
        setProgress(null);
      })
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // The goal race's prediction: re-solved off the first paint when the
  // settings it depends on changed.
  const race = settings.goalRace;
  const wantKey = predictionKey(formInputs);
  useEffect(() => {
    if (!race || race.predictionKey === wantKey) return;
    let cancelled = false;
    setPredicting(true);
    const timer = setTimeout(async () => {
      try {
        const course = (await listStoredCourses()).find((c) => c.id === race.courseId);
        if (cancelled || !course) return;
        const facts = courseFacts(course, formInputs);
        planSettingsStore.set((s) => (s.goalRace?.courseId === race.courseId ? { ...s, goalRace: { ...s.goalRace, ...facts, predictionKey: wantKey } } : s));
      } finally {
        if (!cancelled) setPredicting(false);
      }
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // formInputs is fully represented by wantKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race?.courseId, race?.predictionKey, wantKey]);

  const carbs = useMemo(() => {
    const runs = (history ?? []).map((r) => ({ runId: r.runId, day: r.day, movingMin: r.movingMin }));
    return { raceGPerH: formInputs.intakeGPerH, startGPerH: ladderStart(runs, logs, today, settings.carbsStartGPerH) };
  }, [history, logs, today, formInputs.intakeGPerH, settings.carbsStartGPerH]);

  const generate = useCallback(
    (force: boolean) => {
      if (!history) return;
      const key = planInputsKey(settings, carbs);
      if (!force && (!key || !needsReplan(snapshot, today, key))) return;
      const out = planFromSettings(history, settings, today, carbs);
      if ("snapshot" in out) planSnapshotStore.set({ version: 1, snapshot: out.snapshot });
    },
    [history, settings, carbs, snapshot, today],
  );

  useEffect(() => generate(false), [generate]);

  let blocker: PlanBlocker | null = null;
  if (!race) blocker = "noRace";
  else if (!race.expectedHoursOverride && !race.predictedFinishS) blocker = "noPrediction";
  else if (history && history.length === 0) blocker = "noHistory";

  return {
    history,
    runNames,
    progress,
    snapshot: blocker ? null : snapshot,
    blocker,
    predicting,
    today,
    replanNow: () => generate(true),
  };
}
