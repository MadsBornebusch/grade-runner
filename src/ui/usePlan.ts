import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildHistory } from "../plan/historyCache";
import { dateOfDayNumber, dayNumberOf, type DatedHistoryRun } from "../plan/historyFromRuns";
import { ladderStart } from "../plan/carbLadder";
import { hikeHillRuns, needsReplan, planFromSettings, planInputsKey, type PlanBlocker, type PlanSnapshot } from "../plan/planFromSettings";
import { mondayOf } from "../plan/planGenerator";
import { localDateKey } from "../plan/loadLedger";
import { listStoredCourses } from "../storage/courseLibrary";
import { createLocalStore } from "../storage/localStore";
import { fuelLogStore } from "../storage/fuelLogs";
import { planSettingsStore } from "../storage/planSettings";
import { predictionLogStore, raceLogKey, withPrediction } from "../storage/predictionLog";
import { listStoredRuns, subscribeToRunEdits } from "../storage/runLibrary";
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
  /** The generator threw for these inputs. */
  error: string | null;
  today: number;
  replanNow: () => void;
}

/** Runs -> history -> plan, re-planned only when planFromSettings.ts's
 * rule says so. Also keeps the goal race's cached prediction in step with
 * the athlete's settings. */
export function usePlan(formInputs: FormInputs, pausePrediction = false): PlanState {
  const settings = planSettingsStore.use();
  const { snapshot } = planSnapshotStore.use();
  const logs = fuelLogStore.use().byRunId;
  const [history, setHistory] = useState<DatedHistoryRun[] | null>(null);
  const [runNames, setRunNames] = useState(new Map<string, string>());
  const [raceRunIds, setRaceRunIds] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<PlanState["progress"]>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [predicting, setPredicting] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const today = todayDayNumber();

  // Reload the runs whenever a sync or points download finishes.
  const backfillRunning = useSyncExternalStore(subscribeToBackfill, getBackfillStatus).running;
  const autoFetchRunning = useSyncExternalStore(subscribeToAutoFetch, getAutoFetchStatus).running;
  const syncing = backfillRunning || autoFetchRunning;
  // Only on a running -> idle transition: each load reads every stored
  // track from IndexedDB, which is the slow part of opening the app.
  const wasSyncingRef = useRef(syncing);
  useEffect(() => {
    if (wasSyncingRef.current && !syncing) setReloadKey((k) => k + 1);
    wasSyncingRef.current = syncing;
  }, [syncing]);

  // And after a race tag or treadmill grades change.
  useEffect(() => subscribeToRunEdits(() => setReloadKey((k) => k + 1)), []);

  useEffect(() => {
    let cancelled = false;
    listStoredRuns()
      .then((runs) => {
        if (cancelled) return null;
        setRunNames(new Map(runs.map((r) => [r.id, r.name])));
        setRaceRunIds(new Set(runs.filter((r) => r.raceTag === "race").map((r) => r.id)));
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
    if (!race || race.predictionKey === wantKey || pausePrediction) return;
    let cancelled = false;
    setPredicting(true);
    const timer = setTimeout(async () => {
      try {
        const course = (await listStoredCourses()).find((c) => c.id === race.courseId);
        if (cancelled || !course) return;
        const t0 = performance.now();
        const facts = courseFacts(course, formInputs);
        console.info(`[plan] race prediction took ${Math.round(performance.now() - t0)} ms`);
        planSettingsStore.set((s) => (s.goalRace?.courseId === race.courseId ? { ...s, goalRace: { ...s.goalRace, ...facts, predictionKey: wantKey } } : s));
      } catch {
        // The plan keeps the last prediction.
      } finally {
        if (!cancelled) setPredicting(false);
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setPredicting(false);
    };
    // formInputs is fully represented by wantKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race?.courseId, race?.predictionKey, wantKey, pausePrediction]);

  // Keep a copy of each new prediction for the Progress page.
  const predictedS = race?.predictedFinishS;
  useEffect(() => {
    if (!race || !predictedS) return;
    const key = raceLogKey(race);
    const date = dateOfDayNumber(today);
    predictionLogStore.set((log) => {
      const entries = log.byRace[key] ?? [];
      const next = withPrediction(entries, date, predictedS);
      return next === entries ? log : { ...log, byRace: { ...log.byRace, [key]: next } };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race?.courseId, race?.date, predictedS, today]);

  const carbs = useMemo(() => {
    const runs = (history ?? []).map((r) => ({ runId: r.runId, day: r.day, movingMin: r.movingMin }));
    return { raceGPerH: formInputs.intakeGPerH, startGPerH: ladderStart(runs, logs, today, settings.carbsStartGPerH) };
  }, [history, logs, today, formInputs.intakeGPerH, settings.carbsStartGPerH]);

  const generate = useCallback(
    (force: boolean) => {
      if (!history) return;
      const key = planInputsKey(settings, carbs);
      if (!force && (!key || !needsReplan(snapshot, today, key, [...history, ...hikeHillRuns(settings)]))) return;
      // The strength ramp counts from the first plan; setting it re-plans.
      if (key && !settings.strengthStartedOn) {
        planSettingsStore.set((s) => (s.strengthStartedOn ? s : { ...s, strengthStartedOn: dateOfDayNumber(mondayOf(today)) }));
        return;
      }
      // A generator failure shows as a card; it must not take the app down.
      try {
        const out = planFromSettings(history, settings, today, carbs, raceRunIds);
        if ("snapshot" in out) planSnapshotStore.set({ version: 1, snapshot: out.snapshot });
        setPlanError(null);
      } catch (err) {
        setPlanError(err instanceof Error ? err.message : String(err));
      }
    },
    [history, settings, carbs, snapshot, today, raceRunIds],
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
    error: planError,
    today,
    replanNow: () => generate(true),
  };
}
