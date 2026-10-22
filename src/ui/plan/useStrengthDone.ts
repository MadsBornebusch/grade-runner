import { useMemo } from "react";
import type { PlanSnapshot } from "../../plan/planFromSettings";
import { strengthDoneByDay, type StrengthDone } from "../../plan/strengthDone";
import { planSettingsStore } from "../../storage/planSettings";

/** The plan's strength sessions that are done, by day (YYYY-MM-DD). */
export function useStrengthDone(snapshot: PlanSnapshot | null): Record<string, StrengthDone> {
  const { strengthDone, strengthFromStrava } = planSettingsStore.use();
  return useMemo(() => {
    const days = snapshot?.plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind === "strength").map((s) => s.day)) ?? [];
    return strengthDoneByDay(days, strengthDone, strengthFromStrava);
  }, [snapshot, strengthDone, strengthFromStrava]);
}
