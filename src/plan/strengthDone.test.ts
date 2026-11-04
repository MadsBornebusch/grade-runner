import { describe, expect, it } from "vitest";
import { dayNumberOf } from "./historyFromRuns";
import { strengthDoneByDay, tickDate } from "./strengthDone";

const d = dayNumberOf;
// Week of Monday 2026-10-19; strength planned Tuesday and Thursday.
const planned = [d("2026-10-20"), d("2026-10-22")];
const strava = (name: string, date: string) => ({ source: "strava", name, on: d(date) });

describe("strengthDoneByDay", () => {
  it("ticks the planned session on the day it was logged", () => {
    expect(strengthDoneByDay(planned, {}, { "2026-10-22": "Gym" })).toEqual({ "2026-10-22": strava("Gym", "2026-10-22") });
  });

  it("gives a session on an unplanned day to the nearest open one that week, done that day", () => {
    expect(strengthDoneByDay(planned, {}, { "2026-10-21": "Gym" })).toEqual({ "2026-10-20": strava("Gym", "2026-10-21") });
    expect(strengthDoneByDay(planned, {}, { "2026-10-24": "Gym" })).toEqual({ "2026-10-22": strava("Gym", "2026-10-24") });
  });

  it("doesn't let a shifted session take a slot an on-the-day one fills", () => {
    const done = strengthDoneByDay(planned, {}, { "2026-10-21": "Shifted", "2026-10-20": "On the day" });
    expect(done).toEqual({ "2026-10-20": strava("On the day", "2026-10-20"), "2026-10-22": strava("Shifted", "2026-10-21") });
  });

  it("never crosses into another week, and keeps hand ticks", () => {
    expect(strengthDoneByDay(planned, { "2026-10-20": true }, { "2026-10-26": "Next Monday" })).toEqual({ "2026-10-20": { source: "manual", on: d("2026-10-20") } });
  });

  it("matches a hand tick made late like a Strava one", () => {
    expect(strengthDoneByDay(planned, { "2026-10-21": true }, {})).toEqual({ "2026-10-20": { source: "manual", on: d("2026-10-21") } });
  });
});

describe("tickDate", () => {
  it("ticks a session done late or early on the day it's ticked, within its week", () => {
    expect(tickDate(d("2026-10-20"), d("2026-10-21"))).toBe("2026-10-21");
    expect(tickDate(d("2026-10-22"), d("2026-10-21"))).toBe("2026-10-21");
    expect(tickDate(d("2026-10-20"), d("2026-10-27"))).toBe("2026-10-20"); // a past week's
  });
});
