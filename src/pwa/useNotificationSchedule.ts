import { useEffect, useMemo } from "react";
import { notificationsStore } from "../storage/notifications";
import { planSettingsStore } from "../storage/planSettings";
import type { FormInputs } from "../ui/formInputs";
import { intensityTargets } from "../ui/plan/intensity";
import { notificationSchedule } from "../ui/plan/notificationText";
import type { PlanState } from "../ui/usePlan";
import { ensureRegistered, writeSchedule } from "./dailyNotification";

/** Keeps the service worker's copy of the coming week's notifications in
 * step with the plan, while the morning notification is on. */
export function useNotificationSchedule(plan: PlanState, formInputs: FormInputs) {
  const { dailyEnabled } = notificationsStore.use();
  const race = planSettingsStore.use().goalRace;
  const json = useMemo(() => {
    if (!dailyEnabled || !plan.snapshot || !plan.history) return null;
    const targets = intensityTargets(formInputs, race?.raceEffortWPerKg);
    const sessions = plan.snapshot.plan.weeks.flatMap((w) => w.sessions);
    return JSON.stringify(notificationSchedule(sessions, plan.history, plan.today, targets, race?.name ?? "Race"));
  }, [dailyEnabled, plan.snapshot, plan.history, plan.today, formInputs, race?.raceEffortWPerKg, race?.name]);

  useEffect(() => {
    if (json) writeSchedule(JSON.parse(json)).catch(() => {});
  }, [json]);

  useEffect(() => {
    if (dailyEnabled) ensureRegistered().catch(() => {});
  }, [dailyEnabled]);
}
