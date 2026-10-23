import { describe, expect, it } from "vitest";
import { dateOfDayNumber, dayNumberOf } from "./historyFromRuns";
import { strengthRampLevel } from "./strengthRamp";

const START = "2026-01-05"; // a Monday
const day = (weeks: number, weekday = 1) => dateOfDayNumber(dayNumberOf(START) + 7 * weeks + weekday);
const today = (weeks: number) => dayNumberOf(START) + 7 * weeks + 2;

describe("strengthRampLevel", () => {
  it("starts at 0 and climbs one level per week with strength, up to 6", () => {
    expect(strengthRampLevel(null, [], today(5))).toBe(0);
    expect(strengthRampLevel(START, [], today(0))).toBe(0);
    expect(strengthRampLevel(START, [day(0), day(1), day(2)], today(3))).toBe(3);
    expect(strengthRampLevel(START, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((w) => day(w)), today(9))).toBe(6);
  });

  it("slides back half a level per week without strength", () => {
    const heavy = [0, 1, 2, 3, 4, 5, 6, 7].map((w) => day(w));
    // Three weeks off after reaching heavy: back to 4.5, not to the start.
    expect(strengthRampLevel(START, heavy, today(11))).toBe(4.5);
    expect(strengthRampLevel(START, heavy, today(30))).toBe(0);
  });

  it("counts a week once however many sessions it had, and ignores the current week", () => {
    expect(strengthRampLevel(START, [day(0, 0), day(0, 3), day(0, 5)], today(1))).toBe(1);
    expect(strengthRampLevel(START, [day(0)], today(0))).toBe(0);
  });
});
