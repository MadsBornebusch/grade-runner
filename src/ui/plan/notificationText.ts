// The morning notification's words for a day's sessions, the same wording
// as the Today card (planCopy.ts). Written ahead for the coming week, since
// the service worker shows them without the app open (src/pwa/).
import type { PlannedSession } from "../../plan/planGenerator";
import { dateOfDayNumber, type DatedHistoryRun } from "../../plan/historyFromRuns";
import { KIND_TITLE, climbDescentText, distanceLine, effortDetail, formatMinutes } from "./planCopy";
import type { IntensityTargets } from "./intensity";
import { STRENGTH_FOCUS_TITLE } from "./strengthCopy";

export interface DayNotification {
  title: string;
  body: string;
}

/** Null on a rest day. */
export function dayNotification(sessions: PlannedSession[], targets: IntensityTargets, raceName: string): DayNotification | null {
  if (sessions.some((s) => s.kind === "race")) return { title: `Race day: ${raceName}`, body: "Good luck! Your race plan is in the app." };
  const run = sessions.find((s) => s.kind !== "strength");
  const strength = sessions.find((s) => s.kind === "strength");
  if (!run && !strength) return null;
  const parts: string[] = [];
  if (run) {
    if (run.kind !== "hike") {
      // "1 h 20 or 12 km, whichever comes first" reads whole; "About 8 km" alone.
      const distance = distanceLine(run);
      parts.push(distance.startsWith("or ") ? `${formatMinutes(run.minutes)} ${distance}` : distance.replace(/^./, (c) => c.toUpperCase()));
    }
    const effort = effortDetail(run, targets);
    if (effort) parts.push(effort);
    if (run.kind === "hike" && run.packPct) parts.push(`${run.packPct}% pack`);
    if (run.kind === "hike" ? run.climbM >= 50 : run.descentM >= 50) parts.push(climbDescentText(run.climbM, run.descentM));
    if (run.carbsGPerH) parts.push(`${run.carbsGPerH} g/h carbs`);
  }
  const focus = strength?.strengthFocus ? STRENGTH_FOCUS_TITLE[strength.strengthFocus] : null;
  if (strength && run) parts.push(`Plus strength${focus ? `: ${focus}` : ""}, ${formatMinutes(strength.minutes)}`);
  else if (strength && focus) parts.push(focus);
  const main = run ?? strength!;
  return { title: `${KIND_TITLE[main.kind]} · ${formatMinutes(main.minutes)}`, body: parts.join(" · ") };
}

/** Notifications by local date (YYYY-MM-DD) from `today` for `days` days.
 * Today is left out once a run is logged for it: nothing to remind of. */
export function notificationSchedule(
  sessions: PlannedSession[],
  history: Pick<DatedHistoryRun, "day">[],
  today: number,
  targets: IntensityTargets,
  raceName: string,
  days = 8,
): Record<string, DayNotification> {
  const out: Record<string, DayNotification> = {};
  for (let day = today; day < today + days; day++) {
    if (day === today && history.some((r) => r.day === today)) continue;
    const n = dayNotification(sessions.filter((s) => s.day === day), targets, raceName);
    if (n) out[dateOfDayNumber(day)] = n;
  }
  return out;
}
