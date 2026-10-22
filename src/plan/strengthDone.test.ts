import { describe, expect, it } from "vitest";
import { dayNumberOf } from "./historyFromRuns";
import { strengthDoneByDay } from "./strengthDone";

const d = dayNumberOf;
// Week of Monday 2026-10-19; strength planned Tuesday and Thursday.
const planned = [d("2026-10-20"), d("2026-10-22")];

describe("strengthDoneByDay", () => {
  it("ticks the planned session on the day it was logged", () => {
    expect(strengthDoneByDay(planned, {}, { "2026-10-22": "Gym" })).toEqual({ "2026-10-22": { source: "strava", name: "Gym" } });
  });

  it("gives a session on an unplanned day to the nearest open one that week", () => {
    expect(strengthDoneByDay(planned, {}, { "2026-10-21": "Gym" })).toEqual({ "2026-10-20": { source: "strava", name: "Gym" } });
    expect(strengthDoneByDay(planned, {}, { "2026-10-24": "Gym" })).toEqual({ "2026-10-22": { source: "strava", name: "Gym" } });
  });

  it("doesn't let a shifted session take a slot an on-the-day one fills", () => {
    const done = strengthDoneByDay(planned, {}, { "2026-10-21": "Shifted", "2026-10-20": "On the day" });
    expect(done).toEqual({ "2026-10-20": { source: "strava", name: "On the day" }, "2026-10-22": { source: "strava", name: "Shifted" } });
  });

  it("never crosses into another week, and keeps hand ticks", () => {
    expect(strengthDoneByDay(planned, { "2026-10-20": true }, { "2026-10-26": "Next Monday" })).toEqual({ "2026-10-20": { source: "manual" } });
  });
});
