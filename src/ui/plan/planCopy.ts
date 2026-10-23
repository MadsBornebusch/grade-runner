// Plain-language copy for the plan (UX spec §4). The UI never shows the
// model's words: "chronic", "load", "mechanical", "guard".
import type { Phase, PlannedSession, SessionKind } from "../../plan/planGenerator";
import { dateOfDayNumber } from "../../plan/historyFromRuns";
import type { IntensityTargets } from "./intensity";

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
  quality: "Threshold run",
  descent: "Downhill run",
  hike: "Weighted hike",
  strength: "Strength",
  race: "Race day",
};

const NO_TARGETS: IntensityTargets = { easyMaxHr: null, steady: null, quality: null, raceAtLt1: false };

const bpm = (lo: number, hi: number) => `${lo}–${hi} bpm`;

/** Short effort label for a session card; null where the kind says it all. */
export function effortChip(s: PlannedSession, t: IntensityTargets): string | null {
  if (s.kind === "long") {
    if (s.steadyMinutes) return `${s.steadyMinutes} min steady${t.steady ? ` · ${bpm(t.steady.lo, t.steady.hi)}` : ""}`;
    return t.easyMaxHr ? `Easy · under ${t.easyMaxHr} bpm` : "Easy";
  }
  if (s.kind === "quality") return t.quality ? bpm(t.quality.lo, t.quality.hi) : "Comfortably hard";
  return null;
}

/** The effort line of a session's detail sheet. */
export function effortDetail(s: PlannedSession, t: IntensityTargets): string | null {
  const easy = t.easyMaxHr ? `Easy, under ${t.easyMaxHr} bpm` : "Easy, conversational";
  switch (s.kind) {
    case "easy":
    case "descent":
      return easy;
    case "hike":
      return "Legs burn, breathing stays easy";
    case "long":
      return s.steadyMinutes
        ? `${easy}, with ${s.steadyMinutes} min steady${t.steady ? ` at ${bpm(t.steady.lo, t.steady.hi)}` : " at race effort"}`
        : easy;
    case "quality":
      return t.quality ? `Around LT2, ${bpm(t.quality.lo, t.quality.hi)}` : "Comfortably hard, around your 1-hour race effort";
    default:
      return null;
  }
}

export function howToRun(s: PlannedSession, raceName: string, strengthCounts: boolean, t: IntensityTargets = NO_TARGETS, bodyMassKg?: number): string {
  const under = t.easyMaxHr ? ` (under ${t.easyMaxHr} bpm)` : "";
  switch (s.kind) {
    case "easy":
      return `Relaxed${under}. You can talk in full sentences.`;
    case "long": {
      const carbs = s.carbsGPerH ? ` Take carbs from the first 20 min, a little every 20 min: ${s.carbsGPerH} g/h today.` : "";
      if (!s.steadyMinutes) {
        return `Easy and steady${under}, walk the steep climbs. On a long run heart rate creeps up, so treat it as a ceiling: slow down rather than push to stay in range.${carbs}`;
      }
      const range = t.steady ? `, ${bpm(t.steady.lo, t.steady.hi)}` : "";
      const effort = t.raceAtLt1 ? "steady, just under the top of easy" : "race effort";
      return (
        `Easy${under} for the first ${formatMinutes(s.minutes - s.steadyMinutes - 15)}, then ${s.steadyMinutes} min ${effort}${range}: ` +
        `steady, short sentences only. Finish with about 15 min easy. You're at your longest run, so it grows in effort now, not time: ` +
        `running race effort on tired legs is what the race asks for. Keep it all easy if you slept badly or feel off.${carbs}`
      );
    }
    case "quality": {
      // About half the run at threshold, 10-30 min, inside a warm-up and
      // an easy finish.
      const hard = Math.max(10, Math.min(30, Math.round(s.minutes / 2 / 5) * 5));
      return `Warm up easy, then ${hard} min comfortably hard${t.quality ? ` (${bpm(t.quality.lo, t.quality.hi)})` : ""}, around your 1-hour race effort, then easy to finish. One block or two with a short jog between.`;
    }
    case "descent":
      return `A hilly route with about ${Math.round(s.descentM / 10) * 10} m of descent, easy effort on the climbs${under}. Run the downhills controlled; it trains your legs for the race's descents.`;
    case "hike": {
      const pct = s.packPct ?? 5;
      const kg = bodyMassKg ? `, about ${Math.round((bodyMassKg * pct) / 100)} kg` : "";
      return (
        `Hike the steepest climb you have (15–30%) with a pack of ${pct}% of your body weight${kg}: water works well. ` +
        `At the top, pour it out and run down easy, refill at the bottom and go again, as many times as the time allows; most of it should be climbing. ` +
        `A treadmill at full incline or a stair machine works too. Your legs should give out before your breathing does; ` +
        `if you're panting, slow down or find a steeper slope. Log it as a hike or a run on Strava: either counts.`
      );
    }
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
