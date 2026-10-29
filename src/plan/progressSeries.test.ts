import { describe, expect, it } from "vitest";
import { mondayOf } from "./planGenerator";
import { byMonth, loadSeries, longTermChange, phaseBands, planProjection, weeklyTotals } from "./progressSeries";

const MONDAY = mondayOf(20000);
const run = (day: number, extra: Partial<{ mechanical: number; movingMin: number; distanceKm: number; descentM: number; climbM: number }> = {}) => ({
  day, mechanical: 70, movingMin: 60, distanceKm: 10, descentM: 100, climbM: 100, ...extra,
});

describe("loadSeries", () => {
  it("is empty without runs", () => {
    expect(loadSeries([], MONDAY, MONDAY - 10)).toEqual([]);
  });

  it("reports weekly levels from fromDay to today", () => {
    const runs = Array.from({ length: 200 }, (_, i) => run(MONDAY - 200 + i));
    const s = loadSeries(runs, MONDAY, MONDAY - 9);
    expect(s).toHaveLength(10);
    expect(s[0].day).toBe(MONDAY - 9);
    expect(s.at(-1)!.day).toBe(MONDAY);
    // Today has no run; the levels settle near 7 x 70 a week.
    expect(s.at(-2)!.longTerm).toBeGreaterThan(450);
    expect(s.at(-2)!.recent).toBeCloseTo(490, 0);
    expect(s.at(-1)!.recent).toBeLessThan(s.at(-2)!.recent);
  });

  it("warms up from the first run, not from the window start", () => {
    const runs = Array.from({ length: 100 }, (_, i) => run(MONDAY - 100 + i));
    const inWindow = loadSeries(runs, MONDAY - 1, MONDAY - 10)[0];
    const whole = loadSeries(runs, MONDAY - 1, 0).find((p) => p.day === MONDAY - 10)!;
    expect(inWindow).toEqual(whole);
  });

  it("shows a race in full (no spike cap)", () => {
    const runs = [...Array.from({ length: 60 }, (_, i) => run(MONDAY - 60 + i)), run(MONDAY, { mechanical: 2000 })];
    const s = loadSeries(runs, MONDAY, MONDAY);
    const before = loadSeries(runs, MONDAY - 1, MONDAY - 1)[0];
    expect(s[0].recent - before.recent).toBeCloseTo((7 * (2000 - before.recent / 7)) / 7, 0);
  });
});

describe("longTermChange", () => {
  it("compares with the level `days` back", () => {
    const runs = Array.from({ length: 100 }, (_, i) => run(MONDAY - 100 + i, { mechanical: i < 70 ? 50 : 100 }));
    const s = loadSeries(runs, MONDAY - 1, MONDAY - 40);
    expect(longTermChange(s, 28)).toBeGreaterThan(0.2);
    expect(longTermChange(s.slice(0, 5), 28)).toBeNull();
  });
});

describe("weeklyTotals", () => {
  it("sums runs and hike hills per week, today's week last", () => {
    const runs = [run(MONDAY - 7), run(MONDAY - 6, { movingMin: 90, distanceKm: 15 }), run(MONDAY + 1)];
    const hills = [{ day: MONDAY - 5, climbM: 400, descentM: 0 }];
    const w = weeklyTotals(runs, hills, MONDAY + 2, 3);
    expect(w.map((x) => x.start)).toEqual([MONDAY - 14, MONDAY - 7, MONDAY]);
    expect(w[0]).toMatchObject({ hours: 0, runs: 0 });
    expect(w[1]).toMatchObject({ hours: 2.5, km: 25, runs: 2, climbM: 600, descentM: 200 });
    expect(w[2]).toMatchObject({ hours: 1, runs: 1 });
  });

  it("leaves out runs after today and before the window", () => {
    const w = weeklyTotals([run(MONDAY - 30), run(MONDAY + 3)], [], MONDAY + 2, 2);
    expect(w.every((x) => x.runs === 0)).toBe(true);
  });
});

describe("byMonth", () => {
  it("adds up weeks with the same month key", () => {
    const w = weeklyTotals([run(MONDAY - 14), run(MONDAY - 7), run(MONDAY)], [], MONDAY, 3);
    const m = byMonth(w, (d) => (d < MONDAY ? "a" : "b"));
    expect(m.map((x) => [x.start, x.runs])).toEqual([
      [MONDAY - 14, 2],
      [MONDAY, 1],
    ]);
    // The weeks themselves are untouched.
    expect(w[0].runs).toBe(1);
  });
});

describe("phaseBands", () => {
  it("merges same-phase weeks, lets the plan win and clips to the window", () => {
    const logged = new Map([
      [MONDAY - 21, "base" as const],
      [MONDAY - 14, "base" as const],
      [MONDAY - 7, "deload" as const],
      [MONDAY, "base" as const],
    ]);
    const plan = [{ start: MONDAY, phase: "specific" as const }, { start: MONDAY + 7, phase: "specific" as const }];
    expect(phaseBands(logged, plan, MONDAY - 18, MONDAY + 10)).toEqual([
      { from: MONDAY - 18, to: MONDAY - 7, phase: "base" },
      { from: MONDAY - 7, to: MONDAY, phase: "deload" },
      { from: MONDAY, to: MONDAY + 10, phase: "specific" },
    ]);
  });
});

describe("planProjection", () => {
  it("moves the plan's levels to start at today's displayed level", () => {
    const weeks = [{ start: MONDAY, chronicAtStart: 40 }, { start: MONDAY + 7, chronicAtStart: 45 }, { start: MONDAY + 14, chronicAtStart: 42 }];
    expect(planProjection(weeks, MONDAY + 2, 300, { day: MONDAY + 20, chronic: 38 })).toEqual([
      { day: MONDAY + 2, plan: 300 },
      { day: MONDAY + 7, plan: 335 },
      { day: MONDAY + 14, plan: 314 },
      { day: MONDAY + 20, plan: 286 },
    ]);
  });

  it("is empty without a week containing today", () => {
    expect(planProjection([{ start: MONDAY + 7, chronicAtStart: 40 }], MONDAY, 300)).toEqual([]);
  });
});
