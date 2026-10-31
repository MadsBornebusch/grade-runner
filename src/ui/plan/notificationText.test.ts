import { describe, expect, it } from "vitest";
import type { PlannedSession } from "../../plan/planGenerator";
import { dateOfDayNumber } from "../../plan/historyFromRuns";
import { dayNotification, notificationSchedule } from "./notificationText";
import type { IntensityTargets } from "./intensity";

// Synthetic targets, not anyone's values.
const t: IntensityTargets = { easyMaxHr: 140, steady: null, quality: { lo: 160, hi: 166 }, raceAtLt1: false };
const s = (day: number, kind: PlannedSession["kind"], minutes: number, extra: Partial<PlannedSession> = {}): PlannedSession => ({
  day,
  kind,
  minutes,
  distanceKm: minutes / 6,
  mechanical: 0,
  descentM: 0,
  steepDescentM: 0,
  climbM: 0,
  ...extra,
});

describe("day notification", () => {
  it("is quiet on a rest day", () => {
    expect(dayNotification([], t, "R")).toBeNull();
  });

  it("gives the run's time in the title and distance, effort, hills and carbs in the body", () => {
    expect(dayNotification([s(0, "long", 120, { descentM: 400, climbM: 400, carbsGPerH: 60 })], t, "R")).toEqual({
      title: "Long run · 2 h",
      body: "About 20 km · Easy, under 140 bpm · 400 m up and down · 60 g/h carbs",
    });
  });

  it("adds a strength session after the run, or stands alone", () => {
    expect(dayNotification([s(0, "strength", 30, { strengthFocus: "heavy" }), s(0, "easy", 45)], t, "R")?.body).toBe(
      "About 8 km · Easy, under 140 bpm · Plus strength: Heavy, 30 min",
    );
    expect(dayNotification([s(0, "strength", 30, { strengthFocus: "heavy" })], t, "R")).toEqual({ title: "Strength · 30 min", body: "Heavy" });
  });

  it("keeps the time with a distance limit", () => {
    expect(dayNotification([s(0, "long", 80, { distanceKm: 11.5, allowance: { distanceKm: 12, movingMin: 80, descentM: 0, steepDescentM: 0, climbM: 0 } })], t, "R")?.body).toMatch(/^1 h 20 or 12 km, whichever comes first · /);
  });

  it("gives a hike its pack and climb, without a distance", () => {
    expect(dayNotification([s(0, "hike", 60, { packPct: 15, climbM: 600, descentM: 0 })], t, "R")?.body).toBe(
      "Legs burn, breathing stays easy · 15% pack · 600 m up · 0 m down",
    );
  });

  it("wishes luck on race day", () => {
    expect(dayNotification([s(0, "race", 300)], t, "Hill Race")?.title).toBe("Race day: Hill Race");
  });
});

describe("notification schedule", () => {
  const today = 20000;
  const sessions = [s(today, "easy", 45), s(today + 1, "quality", 50), s(today + 3, "long", 120), s(today + 9, "easy", 40)];

  it("covers the coming days by local date, skipping rest days and days past the window", () => {
    const out = notificationSchedule(sessions, [], today, t, "R");
    expect(Object.keys(out)).toEqual([dateOfDayNumber(today), dateOfDayNumber(today + 1), dateOfDayNumber(today + 3)]);
  });

  it("drops today once a run is logged for it", () => {
    expect(notificationSchedule(sessions, [{ day: today }], today, t, "R")[dateOfDayNumber(today)]).toBeUndefined();
  });
});
