import { describe, expect, it } from "vitest";
import { demonstratedIntake, fuelPresets, ladderStart, runsNeedingFuelLog } from "./carbLadder";
import type { FuelLog } from "../storage/fuelLogs";

const log = (gPerH: number, gi?: FuelLog["gi"]): FuelLog => ({ gPerH, gi, enteredAs: "gPerH", loggedOn: "2026-10-01" });
const runs = [
  { runId: "a", day: 100, movingMin: 150 },
  { runId: "b", day: 107, movingMin: 160 },
  { runId: "c", day: 110, movingMin: 50 },
  { runId: "d", day: 10, movingMin: 200 },
];

describe("demonstratedIntake", () => {
  it("takes the highest intake with a fine stomach on long runs in the last 12 weeks", () => {
    const logs = { a: log(60, 0), b: log(70, 2), c: log(90, 0), d: log(100, 0) };
    expect(demonstratedIntake(runs, logs, 110)).toBe(60);
  });

  it("is null without logs", () => {
    expect(demonstratedIntake(runs, {}, 110)).toBeNull();
  });
});

describe("ladderStart", () => {
  it("starts from the athlete's value before any log", () => {
    expect(ladderStart(runs, {}, 110, 80)).toBe(80);
  });

  it("starts from the demonstrated intake once logged", () => {
    expect(ladderStart(runs, { a: log(85, 1) }, 110, 80)).toBe(85);
  });

  it("holds after a bad stomach and steps down after having to stop", () => {
    expect(ladderStart(runs, { a: log(80, 0), b: log(90, 2) }, 110, 80)).toBe(80);
    expect(ladderStart(runs, { a: log(80, 0), b: log(90, 3) }, 110, 80)).toBe(80);
    expect(ladderStart(runs, { b: log(90, 3) }, 110, 100)).toBe(80);
  });
});

describe("runsNeedingFuelLog", () => {
  it("lists long runs from the last week with no log or skip", () => {
    expect(runsNeedingFuelLog(runs, {}, 110).map((r) => r.runId)).toEqual(["b"]);
    expect(runsNeedingFuelLog(runs, { b: { enteredAs: "gPerH", skipped: true, loggedOn: "x" } }, 110)).toEqual([]);
  });
});

describe("fuelPresets", () => {
  it("centres on the target", () => {
    expect(fuelPresets(90)).toEqual([70, 80, 90, 100, 110]);
    expect(fuelPresets(10)).toEqual([0, 10, 20, 30]);
    expect(fuelPresets(undefined)).toEqual([30, 40, 50, 60, 70]);
  });
});
