// Plain-language copy for the plan (UX spec §4). The UI never shows the
// model's words: "chronic", "load", "mechanical", "guard".
import type { Phase, PlannedSession, SessionKind } from "../../plan/planGenerator";
import { dateOfDayNumber } from "../../plan/historyFromRuns";

export const PHASE_LABEL: Record<Phase, string> = {
  recovery: "Recover",
  maintenance: "Hold",
  base: "Build",
  specific: "Race prep",
  deload: "Easy week",
  taper: "Taper",
  race: "Race",
};

export const PHASE_EXPLAINER: Record<Phase, string> = {
  recovery: "Easy running after your race. Let your legs come back.",
  maintenance: "Keep what you have before building again.",
  base: "A little more than last week.",
  specific: "Like Build, plus a downhill run each week for the race's descents.",
  deload: "Less running this week, so the last weeks sink in.",
  taper: "Less running, same sharpness. You'll feel fresh on race day.",
  race: "Race week. Short, easy runs and rest.",
};

export const KIND_TITLE: Record<SessionKind, string> = {
  long: "Long run",
  easy: "Easy run",
  quality: "Quality run",
  descent: "Downhill run",
  strength: "Strength",
  race: "Race day",
};

export function howToRun(s: PlannedSession, raceName: string, strengthCounts: boolean): string {
  switch (s.kind) {
    case "easy":
      return "Relaxed. You can talk in full sentences.";
    case "long":
      return `Easy and steady, walk the steep climbs.${s.carbsGPerH ? ` Take carbs from the first 20 min, a little every 20 min: ${s.carbsGPerH} g/h today.` : ""}`;
    case "quality":
      return "Warm up, then 20–30 min comfortably hard (around your 1-hour race effort), then easy.";
    case "descent":
      return `A hilly route with about ${Math.round(s.descentM / 10) * 10} m of descent. Run the downhills controlled; it trains your legs for the race's descents.`;
    case "strength":
      return `${Math.round(s.minutes)} min legs and core. ${strengthCounts ? "Counted in your hours." : "Not counted in your running hours."}`;
    case "race":
      return `${raceName}. See your race plan.`;
  }
}

/** "50 min", "2 h 30", "2 h". */
export function formatMinutes(min: number): string {
  const m = Math.round(min / 5) * 5;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
}

/** Exact minutes for done runs: "1 h 42", "48 min". */
export function formatMinutesExact(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** The session's distance line. When the speed estimate comes near the
 * per-run limit (the allowance), the limit is the real cap: "or 23 km,
 * whichever comes first". Otherwise the estimate: "about 8 km". */
export function distanceLine(s: PlannedSession): string {
  const limit = s.allowance?.distanceKm;
  if (limit && s.distanceKm >= 0.8 * limit) return `or ${Math.round(limit)} km, whichever comes first`;
  return `about ${Math.round(s.distanceKm)} km`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAY_LETTER = ["M", "T", "W", "T", "F", "S", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 0 = Monday. */
export const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;
export const dayName = (day: number) => WEEKDAYS[weekdayOf(day)];
export function shortDate(day: number): string {
  const [, m, d] = dateOfDayNumber(day).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
export const dayLabel = (day: number) => `${dayName(day)} ${shortDate(day)}`;
