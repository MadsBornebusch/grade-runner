import { describe, expect, it } from "vitest";
import {
  carbTargets, generatePlan, mondayOf, STRENGTH_MINUTES, hikePackPct, strengthBlockOf, strengthFocuses, recoveryWeeks, slotsForWeek, steadyBlockMinutes, strengthDaysOf, suggestLongRunMaxMinutes, type HistoryRun, type PlanOptions, type WeeklySchedule,
} from "./planGenerator";
import { guardBreaches, referenceAt, runReferences } from "./sessionGuard";

const OPTIONS: PlanOptions = { easyDensity: 70, maxDensity: 85, speedKmh: 9.5, maxDescentPerHour: 350, maxSteepDescentPerHour: 120 };
const TODAY = 20000; // a Friday; plans start the next Monday unless includeCurrentWeek

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
  const weeklyMinutes = 120 + Math.floor(360 * r());
  const schedule: WeeklySchedule = {
    weeklyMinutes, longRunWeekday: Math.floor(7 * r()), longRunMaxMinutes: 60 + Math.floor(240 * r()),
    longRunWeekEvery: r() < 0.5 ? 1 : 2, runsPerWeek: 2 + Math.floor(4 * r()),
  };
  const hist = history(r, 10 + Math.floor(20 * r()), 1 + Math.floor(4 * r()), 30 + 30 * r(), 60 + 90 * r(), r() < 0.5 ? Math.floor(5 + 30 * r()) : undefined);
  const race = { name: "test", day: TODAY + 30 + Math.floor(200 * r()), expectedHours: 1 + 10 * r() };
  // Move the long run in one random week.
  schedule.longRunWeekdayByWeek = new Map([[TODAY - ((((TODAY + 3) % 7) + 7) % 7) + 7 * (2 + Math.floor(6 * r())), Math.floor(7 * r())]]);
  return { schedule, hist, race };
}

describe("generatePlan invariants (random cases)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`case ${seed}: budget, slots, guards, taper`, () => {
      const { schedule, hist, race } = randomCase(seed);
      const plan = generatePlan(hist, schedule, race, TODAY, OPTIONS);
      for (const w of plan.weeks) {
        expect(w.plannedMinutes).toBeLessThanOrEqual(schedule.weeklyMinutes + 1e-6);
        const runs = w.sessions.filter((s) => s.kind !== "race" && s.kind !== "strength");
        expect(new Set(runs.map((s) => s.day)).size).toBe(runs.length); // one run a day
        for (const s of runs) expect(s.minutes).toBeLessThanOrEqual((s.kind === "long" ? schedule.longRunMaxMinutes : 75) + 1e-6);
        const longDay = schedule.longRunWeekdayByWeek?.get(w.start) ?? schedule.longRunWeekday;
        for (const s of runs.filter((x) => x.kind === "long")) expect(s.day - w.start).toBe(longDay);
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
      // Strength by phase (two in build weeks, one in lighter weeks, none
      // in race week or right after a race), outside the budget, never on
      // or the day before a long run, each with a focus.
      const expected: Record<string, number> = { race: 0, recovery: 0, taper: 1, maintenance: 1, deload: 1, base: 2, specific: 2 };
      for (const w of plan.weeks) {
        const strength = w.sessions.filter((x) => x.kind === "strength");
        expect(strength.length).toBe(expected[w.phase]);
        for (const x of strength) expect(longDays.has(x.day) || longDays.has(x.day + 1)).toBe(false);
        for (const x of strength) expect(x.strengthFocus).toBeDefined();
        // At most one hike, and never alongside the gym endurance circuit.
        const hikes = w.sessions.filter((x) => x.kind === "hike");
        expect(hikes.length).toBeLessThanOrEqual(1);
        if (hikes.length) expect(strength.some((x) => x.strengthFocus === "circuit")).toBe(false);
      }
      // Taper and race week lighter than the last build week.
      const lastBuild = [...plan.weeks].reverse().find((w) => w.phase === "base" || w.phase === "specific");
      for (const w of plan.weeks.filter((x) => x.phase === "taper" || x.phase === "race")) {
        if (lastBuild) expect(w.plannedMechanical).toBeLessThan(lastBuild.plannedMechanical + 1e-6);
      }
    });
  }
});

describe("strength blocks", () => {
  it("moves from general to heavy to leg endurance as the race nears", () => {
    expect(strengthBlockOf(30)).toBe("general");
    expect(strengthBlockOf(24)).toBe("heavy");
    expect(strengthBlockOf(13)).toBe("heavy");
    expect(strengthBlockOf(12)).toBe("me");
    expect(strengthBlockOf(1)).toBe("me");
  });

  it("grows the hike's pack from 5% to at most 10% of body weight", () => {
    expect(hikePackPct(12)).toBe(5);
    expect(hikePackPct(10)).toBe(6);
    expect(hikePackPct(2)).toBe(10);
    expect(hikePackPct(0)).toBe(10);
  });

  it("picks each session's focus by phase and block", () => {
    expect(strengthFocuses("base", "general", 2, false)).toEqual(["general", "general"]);
    expect(strengthFocuses("base", "heavy", 2, false)).toEqual(["heavy", "heavyJumps"]);
    expect(strengthFocuses("specific", "me", 2, true)).toEqual(["maintenance", "power"]);
    expect(strengthFocuses("specific", "me", 2, false)).toEqual(["circuit", "maintenance"]);
    expect(strengthFocuses("base", "heavy", 3, false)).toEqual(["heavy", "heavyJumps", "heavy"]);
    expect(strengthFocuses("deload", "heavy", 2, false)).toEqual(["deload"]);
    expect(strengthFocuses("deload", "general", 2, false)).toEqual(["general"]);
    expect(strengthFocuses("taper", "me", 2, false)).toEqual(["sharpen"]);
    expect(strengthFocuses("race", "me", 2, false)).toEqual([]);
    expect(strengthFocuses("recovery", "general", 2, false)).toEqual([]);
    expect(strengthFocuses("taper", "me", 0, false)).toEqual([]);
  });
});

describe("strength and hikes through a long plan", () => {
  // Synthetic athlete: 5 runs a week, Saturday long run, race 30 weeks out.
  const schedule: WeeklySchedule = { weeklyMinutes: 420, longRunWeekday: 5, longRunMaxMinutes: 180, runsPerWeek: 5 };
  const r = rng(7);
  const hist = history(r, 12, 5, 50, 120);
  const raceDay = TODAY + 7 * 30;
  const plan = generatePlan(hist, schedule, { name: "test", day: raceDay, expectedHours: 10 }, TODAY, OPTIONS);
  const weeksToRace = (w: { start: number }) => (mondayOf(raceDay) - w.start) / 7;

  it("hikes only in build weeks of the last 12 before the race, pack growing", () => {
    const hikes = plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind === "hike").map((s) => ({ w, s })));
    expect(hikes.length).toBeGreaterThan(3);
    for (const { w, s } of hikes) {
      expect(weeksToRace(w)).toBeLessThanOrEqual(12);
      expect(["base", "specific"]).toContain(w.phase);
      expect(s.packPct).toBe(hikePackPct(weeksToRace(w)));
    }
  });

  it("general strength early, heavy in the middle", () => {
    const focusesOf = (pred: (n: number) => boolean) =>
      new Set(plan.weeks.filter((w) => (w.phase === "base" || w.phase === "specific") && pred(weeksToRace(w))).flatMap((w) => w.sessions.map((s) => s.strengthFocus).filter(Boolean)));
    expect([...focusesOf((n) => n > 24)]).toEqual(["general"]);
    expect(focusesOf((n) => n <= 24 && n > 12)).toEqual(new Set(["heavy", "heavyJumps"]));
  });

  it("each strength session lasts its focus's minutes", () => {
    for (const x of plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind === "strength"))) expect(x.minutes).toBe(STRENGTH_MINUTES[x.strengthFocus!]);
  });

  it("strength counted in the budget keeps every week within it", () => {
    const inBudget = generatePlan(hist, schedule, { name: "test", day: raceDay, expectedHours: 10 }, TODAY, { ...OPTIONS, strengthCountsInBudget: true });
    for (const w of inBudget.weeks) expect(w.plannedMinutes).toBeLessThanOrEqual(schedule.weeklyMinutes + 1e-6);
    expect(inBudget.weeks.some((w) => w.sessions.some((s) => s.kind === "strength" && s.minutes >= 40))).toBe(true);
  });

  it("the taper's one session is the earliest strength day of that week", () => {
    const taper = plan.weeks.find((w) => w.phase === "taper")!;
    const strength = taper.sessions.filter((s) => s.kind === "strength");
    expect(strength).toHaveLength(1);
    expect(strength[0].strengthFocus).toBe("sharpen");
    expect(strength[0].day - taper.start).toBeLessThanOrEqual(1);
  });

  it("no quality session the day after strength when another day is free", () => {
    for (const w of plan.weeks) {
      const q = w.sessions.find((s) => s.kind === "quality");
      if (!q) continue;
      const afterStrength = new Set(w.sessions.filter((s) => s.kind === "strength").map((s) => s.day + 1));
      if (!afterStrength.has(q.day)) continue;
      const longDay = w.sessions.find((s) => s.kind === "long")?.day;
      const alternatives = w.sessions.filter((s) => (s.kind === "easy" || s.kind === "descent" || s.kind === "hike") && !afterStrength.has(s.day) && s.day !== (longDay ?? -9) + 1);
      expect(alternatives).toEqual([]);
    }
  });
});

describe("strengthDaysOf", () => {
  it("spreads sessions and avoids the long run and the day before it", () => {
    expect(strengthDaysOf([{ weekday: 5, minutes: 150 }], 5, 2, false)).toEqual([0, 3]);
    expect(strengthDaysOf([{ weekday: 1, minutes: 50 }, { weekday: 3, minutes: 50 }, { weekday: 5, minutes: 150 }], 5, 2, false)).toEqual([1, 3]);
    // Inside the budget only slot days qualify.
    expect(strengthDaysOf([{ weekday: 1, minutes: 50 }, { weekday: 5, minutes: 150 }], 5, 2, true)).toEqual([1]);
  });
});

describe("current week and past races", () => {
  const schedule: WeeklySchedule = { weeklyMinutes: 300, longRunWeekday: 5, longRunMaxMinutes: 180 };
  // TODAY (day 20000) is a Friday; its Monday is 19996.
  const hist = history(rng(10), 12, 3, 45, 100).filter((r) => r.day < TODAY);

  it("plans the rest of this week from today, net of what's been run since Monday", () => {
    const plan = generatePlan(hist, schedule, { name: "r", day: TODAY + 120, expectedHours: 6 }, TODAY, { ...OPTIONS, includeCurrentWeek: true });
    const first = plan.weeks[0];
    expect(first.start).toBe(19996);
    for (const x of first.sessions) expect(x.day).toBeGreaterThanOrEqual(TODAY);
    const done = hist.filter((r) => r.day >= 19996).reduce((a, r) => a + r.movingMin, 0);
    expect(first.plannedMinutes).toBeLessThanOrEqual(300 - done + 1e-6);
  });

  it("returns an empty plan for a race already run, and attaches allowances", () => {
    expect(generatePlan(hist, schedule, { name: "r", day: TODAY - 1, expectedHours: 6 }, TODAY, OPTIONS).status).toBe("racePast");
    const plan = generatePlan(hist, schedule, { name: "r", day: TODAY + 120, expectedHours: 6 }, TODAY, OPTIONS);
    const long = plan.weeks.flatMap((w) => w.sessions).find((x) => x.kind === "long")!;
    expect(long.allowance!.movingMin).toBeGreaterThanOrEqual(long.minutes);
    expect(long.allowance!.distanceKm).toBeGreaterThanOrEqual(long.distanceKm);
  });
});

describe("carbs", () => {
  it("steps up from the demonstrated intake to the race target and holds", () => {
    expect(carbTargets(5, { raceGPerH: 70, startGPerH: 55 })).toEqual([55, 60, 65, 70, 70]);
    expect(carbTargets(2, { raceGPerH: 40, startGPerH: 60 })).toEqual([40, 40]);
  });

  it("puts targets on fuelled runs only, rising, and the race at its target", () => {
    const schedule: WeeklySchedule = { weeklyMinutes: 300, longRunWeekday: 5, longRunMaxMinutes: 210 };
    const plan = generatePlan(history(rng(9), 20, 3, 45, 120), schedule, { name: "r", day: TODAY + 200, expectedHours: 10 }, TODAY, { ...OPTIONS, carbs: { raceGPerH: 70 } });
    const all = plan.weeks.flatMap((w) => w.sessions);
    for (const x of all) if (x.kind !== "race") expect(x.carbsGPerH !== undefined).toBe(x.kind !== "strength" && x.minutes >= 90);
    const g = all.filter((x) => x.carbsGPerH !== undefined && x.kind !== "race").map((x) => x.carbsGPerH!);
    expect(g[0]).toBe(30);
    g.slice(1).forEach((v, k) => expect(v).toBeGreaterThanOrEqual(g[k]));
    expect(all.find((x) => x.kind === "race")!.carbsGPerH).toBe(70);
    expect(plan.warnings.some((w) => w.includes("g/h"))).toBe(false);
  });
});

describe("schedule", () => {
  it("spreads the other runs around the long run and moves it in a given week", () => {
    const schedule: WeeklySchedule = { weeklyMinutes: 300, longRunWeekday: 5, longRunMaxMinutes: 210, runsPerWeek: 4 };
    const normal = slotsForWeek(schedule, 0, false);
    expect(normal.slots.map((s) => s.weekday)).toEqual([5, 1, 3, 6]); // Tue, Thu, Sun
    expect(normal.slots[0].minutes).toBe(150); // half the week outside long-run weeks
    expect(slotsForWeek(schedule, 0, true).slots[0].minutes).toBe(210);
    const moved = slotsForWeek({ ...schedule, longRunWeekdayByWeek: new Map([[7, 6]]) }, 7, false);
    expect(moved.longRunWeekday).toBe(6);
  });

  it("suggests a long-run max from the race, held below the weekly volume", () => {
    expect(suggestLongRunMaxMinutes(14, 600)).toBe(300);
    expect(suggestLongRunMaxMinutes(14, 300)).toBe(225);
    expect(suggestLongRunMaxMinutes(3, 600)).toBe(120);
  });
});

describe("generatePlan structure", () => {
  const schedule: WeeklySchedule = { weeklyMinutes: 300, longRunWeekday: 5, longRunMaxMinutes: 240 };

  it("alternates long-run weeks, which lengthen the long run within the same weekly budget", () => {
    const plan = generatePlan(history(rng(8), 20, 3, 45, 140), schedule, { name: "r", day: TODAY + 200, expectedHours: 6 }, TODAY, OPTIONS);
    const builds = plan.weeks.filter((w) => w.phase === "base" || w.phase === "specific");
    builds.forEach((w, k) => expect(w.longRunWeek).toBe((k + 1) % 2 === 0));
    const long = (w: (typeof builds)[number]) => w.sessions.find((x) => x.kind === "long")?.minutes ?? 0;
    expect(Math.max(...builds.map(long))).toBeGreaterThan(150);
    for (const w of builds) expect(w.plannedMinutes).toBeLessThanOrEqual(300 + 1e-6);
    expect(plan.weeks.some((w) => w.longRunWeek && (w.phase === "deload" || w.phase === "taper"))).toBe(false);
  });

  it("deloads every 4th build week", () => {
    const plan = generatePlan(history(rng(3), 20, 3, 45, 90), schedule, { name: "r", day: TODAY + 200, expectedHours: 5 }, TODAY, OPTIONS);
    const builds = plan.weeks.filter((w) => ["base", "specific", "deload"].includes(w.phase));
    builds.forEach((w, k) => expect(w.phase === "deload").toBe((k + 1) % 4 === 0));
  });

  it("starts with recovery weeks after a recent long race, none after an old one", () => {
    const recent = generatePlan(history(rng(4), 20, 3, 45, 90, 3, 900), schedule, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    const rec = recoveryWeeks(900);
    expect(recent.weeks.slice(0, rec.easy).map((w) => w.phase)).toEqual(new Array(rec.easy).fill("recovery"));
    expect(recent.weeks[rec.easy].phase).toBe("maintenance");
    const old = generatePlan(history(rng(4), 20, 3, 45, 90, 60, 900), schedule, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    expect(old.weeks[0].phase).toBe("base");
  });

  it("doesn't let a recent race raise the long-run allowance", () => {
    const plan = generatePlan(history(rng(5), 20, 3, 45, 90, 10, 600), schedule, { name: "r", day: TODAY + 150, expectedHours: 5 }, TODAY, OPTIONS);
    const firstLong = plan.weeks.flatMap((w) => w.sessions).find((s) => s.kind === "long")!;
    expect(firstLong.minutes).toBeLessThanOrEqual(1.1 * 90 + 1e-6);
  });

  it("warns when the budget can't reach the load before a comparable past race", () => {
    // A big build ending in an 8 h race 200 days ago, then a goal race of
    // the same length on a 2 h/week budget.
    const hist = [...history(rng(6), 30, 6, 80, 180).map((r) => ({ ...r, day: r.day - 200 })), ...history(rng(7), 25, 2, 40, 60)];
    hist.push({ day: TODAY - 200, movingMin: 480, distanceKm: 55, descentM: 2000, steepDescentM: 500, mechanical: 450 });
    hist.sort((a, b) => a.day - b.day);
    const small: WeeklySchedule = { weeklyMinutes: 120, longRunWeekday: 5, longRunMaxMinutes: 80, runsPerWeek: 2 };
    const plan = generatePlan(hist, small, { name: "r", day: TODAY + 120, expectedHours: 6 }, TODAY, OPTIONS);
    expect(plan.warnings.some((w) => w.includes("below the level before comparable past races"))).toBe(true);
    expect(plan.budgetBindsFrom).not.toBeNull();
  });
});

describe("steady block on capped long runs", () => {
  it("starts at zero, grows 10 min per earlier capped run, and caps at a third and an hour", () => {
    expect(steadyBlockMinutes(100, 150, 180, [86, 72])).toBe(0); // under the cap
    expect(steadyBlockMinutes(100, 180, 180, [])).toBe(0); // first capped run
    expect(steadyBlockMinutes(100, 180, 180, [86])).toBe(10);
    expect(steadyBlockMinutes(100, 180, 180, [86, 72, 58])).toBe(30);
    expect(steadyBlockMinutes(100, 120, 120, [90, 80, 70, 60, 50])).toBe(40); // a third of 120
    expect(steadyBlockMinutes(400, 210, 210, Array.from({ length: 12 }, (_, k) => 386 - 14 * k))).toBe(60);
  });

  it("starts over after a gap of more than four weeks", () => {
    expect(steadyBlockMinutes(100, 180, 180, [86, 72])).toBe(20);
    expect(steadyBlockMinutes(100, 180, 180, [70, 56])).toBe(0);
    expect(steadyBlockMinutes(100, 180, 180, [86, 50])).toBe(10);
  });

  it("only appears in build weeks once the long run is at the cap, growing and adding load", () => {
    const schedule: WeeklySchedule = { weeklyMinutes: 360, longRunWeekday: 5, longRunMaxMinutes: 150 };
    const plan = generatePlan(history(rng(11), 20, 3, 50, 120), schedule, { name: "r", day: TODAY + 150, expectedHours: 10 }, TODAY, OPTIONS);
    const longs = plan.weeks.flatMap((w) => w.sessions.filter((x) => x.kind === "long").map((x) => ({ x, phase: w.phase })));
    for (const { x, phase } of longs) {
      if (!x.steadyMinutes) continue;
      expect(["base", "specific"]).toContain(phase);
      expect(x.minutes).toBeGreaterThanOrEqual(0.95 * 150);
      expect(x.mechanical).toBeGreaterThan((x.minutes / 60) * OPTIONS.easyDensity);
      expect(x.steadyMinutes).toBeLessThanOrEqual(x.minutes / 3);
    }
    const blocks = longs.map(({ x }) => x.steadyMinutes ?? 0).filter((m) => m > 0);
    expect(blocks.length).toBeGreaterThan(2);
    expect(Math.max(...blocks)).toBeGreaterThan(blocks[0]);
    expect(longs.some(({ x, phase }) => (phase === "deload" || phase === "taper") && x.steadyMinutes)).toBe(false);
  });
});
