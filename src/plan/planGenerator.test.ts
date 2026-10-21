import { describe, expect, it } from "vitest";
import { generatePlan, recoveryWeeks, strengthDaysOf, type AvailabilitySlot, type HistoryRun, type PlanOptions } from "./planGenerator";
import { guardBreaches, referenceAt, runReferences } from "./sessionGuard";

const OPTIONS: PlanOptions = { easyDensity: 70, maxDensity: 85, speedKmh: 9.5, maxDescentPerHour: 350, maxSteepDescentPerHour: 120 };
const TODAY = 20000; // a Sunday... any day works; weeks start the next Monday

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** `weeks` of history ending the day before TODAY: `perWeek` runs a week of
 * about `minutes`, with a long run of `longMin`, plus an optional race. */
function history(r: () => number, weeks: number, perWeek: number, minutes: number, longMin: number, raceDaysAgo?: number, raceMin = 400): HistoryRun[] {
  const out: HistoryRun[] = [];
  for (let d = TODAY - 7 * weeks; d < TODAY; d++) {
    const dow = (d - (TODAY - 7 * weeks)) % 7;
    const run = dow === 5 ? longMin : dow < perWeek ? minutes * (0.8 + 0.4 * r()) : 0;
    if (!run) continue;
    out.push({ day: d, movingMin: run, distanceKm: (run / 60) * 9.5, descentM: (run / 60) * 150, steepDescentM: (run / 60) * 40, mechanical: (run / 60) * 70 });
  }
  if (raceDaysAgo !== undefined) {
    const h = raceMin / 60;
    out.push({ day: TODAY - raceDaysAgo, movingMin: raceMin, distanceKm: h * 8, descentM: h * 300, steepDescentM: h * 80, mechanical: h * 75 });
  }
  return out.sort((a, b) => a.day - b.day);
}

function randomCase(seed: number) {
  const r = rng(seed);
  const slots: AvailabilitySlot[] = [];
  for (let wd = 0; wd < 7; wd++) if (r() < 0.6 || wd === 5) slots.push({ weekday: wd, minutes: wd === 5 ? 90 + Math.floor(150 * r()) : 30 + Math.floor(50 * r()) });
  const hist = history(r, 10 + Math.floor(20 * r()), 1 + Math.floor(4 * r()), 30 + 30 * r(), 60 + 90 * r(), r() < 0.5 ? Math.floor(5 + 30 * r()) : undefined);
  const race = { name: "test", day: TODAY + 30 + Math.floor(200 * r()), expectedHours: 1 + 10 * r() };
  return { slots, hist, race };
}

describe("generatePlan invariants (random cases)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`case ${seed}: budget, slots, guards, taper`, () => {
      const { slots, hist, race } = randomCase(seed);
      const plan = generatePlan(hist, slots, 5, race, TODAY, OPTIONS);
      const budget = slots.reduce((s, x) => s + x.minutes, 0);
      const slotOf = new Map(slots.map((s) => [s.weekday, s.minutes]));
      for (const w of plan.weeks) {
        expect(w.plannedMinutes).toBeLessThanOrEqual(budget + 1e-6);
        const perDay = new Map<number, number>();
        for (const s of w.sessions) if (s.kind !== "race" && s.kind !== "strength") perDay.set(s.day, (perDay.get(s.day) ?? 0) + s.minutes);
        for (const [day, m] of perDay) expect(m).toBeLessThanOrEqual((slotOf.get(day - w.start) ?? 0) + 1e-6);
      }
      // Every planned run within the guard of everything before it.
      const { isRace } = runReferences(hist);
      const before = hist.filter((_, i) => !isRace[i]);
      const planned = plan.weeks
        .flatMap((w) => w.sessions.filter((s) => s.kind !== "race" && s.kind !== "strength"))
        .map((s) => ({ day: s.day, movingMin: s.minutes, distanceKm: s.distanceKm, descentM: s.descentM, steepDescentM: s.steepDescentM }));
      planned.forEach((s, i) => {
        const ref = referenceAt([...before, ...planned.slice(0, i)], s.day);
        expect(guardBreaches(s, ref)).toEqual([]);
      });
      // At most one quality session a week, never the day after a long run.
      const all = plan.weeks.flatMap((w) => w.sessions);
      const longDays = new Set(all.filter((x) => x.kind === "long").map((x) => x.day));
      for (const w of plan.weeks) expect(w.sessions.filter((x) => x.kind === "quality").length).toBeLessThanOrEqual(1);
      for (const q of all.filter((x) => x.kind === "quality")) expect(longDays.has(q.day - 1)).toBe(false);
      // Two strength sessions every week but race week, outside the budget,
      // never on or the day before a long run.
      for (const w of plan.weeks) {
        const strength = w.sessions.filter((x) => x.kind === "strength");
        expect(strength.length).toBe(w.phase === "race" ? 0 : 2);
        for (const x of strength) expect(longDays.has(x.day) || longDays.has(x.day + 1)).toBe(false);
      }
      // Taper and race week lighter than the last build week.
      const lastBuild = [...plan.weeks].reverse().find((w) => w.phase === "base" || w.phase === "specific");
      for (const w of plan.weeks.filter((x) => x.phase === "taper" || x.phase === "race")) {
        if (lastBuild) expect(w.plannedMechanical).toBeLessThan(lastBuild.plannedMechanical + 1e-6);
      }
    });
  }
});

describe("strengthDaysOf", () => {
  it("spreads sessions and avoids the long run and the day before it", () => {
    expect(strengthDaysOf([{ weekday: 5, minutes: 150 }], 5, 2, false)).toEqual([0, 3]);
    expect(strengthDaysOf([{ weekday: 1, minutes: 50 }, { weekday: 3, minutes: 50 }, { weekday: 5, minutes: 150 }], 5, 2, false)).toEqual([1, 3]);
    // Inside the budget only slot days qualify.
    expect(strengthDaysOf([{ weekday: 1, minutes: 50 }, { weekday: 5, minutes: 150 }], 5, 2, true)).toEqual([1]);
  });
});

describe("generatePlan structure", () => {
  const slots: AvailabilitySlot[] = [{ weekday: 1, minutes: 50 }, { weekday: 3, minutes: 50 }, { weekday: 5, minutes: 150 }, { weekday: 6, minutes: 50 }];

  it("deloads every 4th build week", () => {
    const plan = generatePlan(history(rng(3), 20, 3, 45, 90), slots, 5, { name: "r", day: TODAY + 200, expectedHours: 5 }, TODAY, OPTIONS);
    const builds = plan.weeks.filter((w) => ["base", "specific", "deload"].includes(w.phase));
    builds.forEach((w, k) => expect(w.phase === "deload").toBe((k + 1) % 4 === 0));
  });

  it("starts with recovery weeks after a recent long race, none after an old one", () => {
    const recent = generatePlan(history(rng(4), 20, 3, 45, 90, 3, 900), slots, 5, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    const rec = recoveryWeeks(900);
    expect(recent.weeks.slice(0, rec.easy).map((w) => w.phase)).toEqual(new Array(rec.easy).fill("recovery"));
    expect(recent.weeks[rec.easy].phase).toBe("maintenance");
    const old = generatePlan(history(rng(4), 20, 3, 45, 90, 60, 900), slots, 5, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    expect(old.weeks[0].phase).toBe("base");
  });

  it("doesn't let a recent race raise the long-run allowance", () => {
    const plan = generatePlan(history(rng(5), 20, 3, 45, 90, 10, 600), slots, 5, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    const firstLong = plan.weeks.flatMap((w) => w.sessions).find((s) => s.kind === "long")!;
    expect(firstLong.minutes).toBeLessThanOrEqual(1.1 * 90 + 1e-6);
  });

  it("warns when the budget can't reach the load before a comparable past race", () => {
    // A big build ending in an 8 h race 200 days ago, then a goal race of
    // the same length on a 2 h/week budget.
    const hist = [...history(rng(6), 30, 6, 80, 180).map((r) => ({ ...r, day: r.day - 200 })), ...history(rng(7), 25, 2, 40, 60)];
    hist.push({ day: TODAY - 200, movingMin: 480, distanceKm: 55, descentM: 2000, steepDescentM: 500, mechanical: 450 });
    hist.sort((a, b) => a.day - b.day);
    const small: AvailabilitySlot[] = [{ weekday: 2, minutes: 40 }, { weekday: 5, minutes: 80 }];
    const plan = generatePlan(hist, small, 5, { name: "r", day: TODAY + 120, expectedHours: 6 }, TODAY, OPTIONS);
    expect(plan.warnings.some((w) => w.includes("below the level before comparable past races"))).toBe(true);
    expect(plan.budgetBindsFrom).not.toBeNull();
  });
});
