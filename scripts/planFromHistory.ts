// PLAN.md §15 stage 4: print a plan from the cached history for a goal race.
//
//   npx tsx scripts/planFromHistory.ts [--today=YYYY-MM-DD]
//
// The goal race and weekly schedule come from athlete.local.json's optional
// "plan" section:
//   "plan": { "race": { "name", "date", "expectedHours", "descentM"?, "steepDescentM"? },
//             "weeklyMinutes": 300, "longRunWeekday": 5 (Mon=0), "longRunMaxMinutes"?: 210,
//             "longRunWeekEvery"?: 2, "runsPerWeek"?: 4,
//             "longRunWeekdayByWeek"?: { "YYYY-MM-DD" (a Monday): weekday },
//             "strengthCountsInBudget"?: false }
// Without it, a clearly labelled example is used. Without longRunMaxMinutes,
// the suggestion from the race is used.
import { generatePlan, suggestLongRunMaxMinutes, type GoalRace, type HistoryRun, type WeeklySchedule } from "../src/plan/planGenerator.ts";
import { runReferences, guardBreaches, referenceAt } from "../src/plan/sessionGuard.ts";
import { arg } from "./stravaScriptHelpers.ts";
import { dayNumber, loadPlanRuns } from "./planRunData.ts";
import { loadAthleteProfile } from "./athleteProfile.ts";

interface PlanSection {
  race: { name: string; date: string; expectedHours: number; descentM?: number; steepDescentM?: number };
  weeklyMinutes: number;
  longRunWeekday: number;
  longRunMaxMinutes?: number;
  longRunWeekEvery?: number;
  runsPerWeek?: number;
  longRunWeekdayByWeek?: Record<string, number>;
  strengthCountsInBudget?: boolean;
}
const EXAMPLE: PlanSection = {
  race: { name: "EXAMPLE 50 km trail race", date: "2027-05-29", expectedHours: 6.5, descentM: 2000, steepDescentM: 500 },
  weeklyMinutes: 300,
  longRunWeekday: 5,
};
const section = loadAthleteProfile().plan as PlanSection | undefined;
const cfg = section ?? EXAMPLE;
if (!section) console.log("No \"plan\" section in athlete.local.json: using the EXAMPLE race and schedule.\n");

const today = dayNumber(arg("today", new Date().toISOString().slice(0, 10)));
const runs = loadPlanRuns().filter((r) => r.day < today);
const history: HistoryRun[] = runs.map((r) => ({
  day: r.day, movingMin: r.movingMin, distanceKm: r.distanceKm, descentM: r.load.descentM, steepDescentM: r.load.steepDescentM, mechanical: r.load.mechanical,
}));

// Density and speed from the athlete's own points-based runs of 30+ min.
const pts = runs.filter((r) => r.load.source === "points" && r.movingMin >= 30);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const perHour = (f: (r: (typeof pts)[number]) => number) => pts.map((r) => f(r) / (r.movingMin / 60));
const options = {
  easyDensity: q(perHour((r) => r.load.mechanical), 0.5),
  maxDensity: q(perHour((r) => r.load.mechanical), 0.9),
  speedKmh: q(perHour((r) => r.distanceKm), 0.5),
  maxDescentPerHour: q(perHour((r) => r.load.descentM), 0.9),
  maxSteepDescentPerHour: q(perHour((r) => r.load.steepDescentM), 0.9),
  strengthCountsInBudget: cfg.strengthCountsInBudget ?? false,
};
console.log(`From ${pts.length} runs: load/h easy ${options.easyDensity.toFixed(0)}, dense ${options.maxDensity.toFixed(0)}; ${options.speedKmh.toFixed(1)} km/h; descent/h up to ${options.maxDescentPerHour.toFixed(0)} m, steep ${options.maxSteepDescentPerHour.toFixed(0)} m`);

const race: GoalRace = { name: cfg.race.name, day: dayNumber(cfg.race.date), expectedHours: cfg.race.expectedHours, descentM: cfg.race.descentM, steepDescentM: cfg.race.steepDescentM };
const suggested = suggestLongRunMaxMinutes(race.expectedHours, cfg.weeklyMinutes);
const schedule: WeeklySchedule = {
  weeklyMinutes: cfg.weeklyMinutes,
  longRunWeekday: cfg.longRunWeekday,
  longRunMaxMinutes: cfg.longRunMaxMinutes ?? suggested,
  longRunWeekEvery: cfg.longRunWeekEvery,
  runsPerWeek: cfg.runsPerWeek,
  longRunWeekdayByWeek: new Map(Object.entries(cfg.longRunWeekdayByWeek ?? {}).map(([d, wd]) => [dayNumber(d), wd])),
};
console.log(`Long run max ${schedule.longRunMaxMinutes} min${cfg.longRunMaxMinutes ? ` (suggested from the race: ${suggested})` : " (suggested from the race)"}`);
const plan = generatePlan(history, schedule, race, today, options);

const iso = (d: number) => new Date(d * 864e5).toISOString().slice(0, 10);
const days = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
console.log(`\n${race.name}, ${cfg.race.date}, ~${race.expectedHours} h. Budget ${(cfg.weeklyMinutes / 60).toFixed(1)} h/week.`);
console.log("week        phase        chronic  target  planned   hours  sessions (min, descent/steep m)");
for (const w of plan.weeks) {
  const ss = w.sessions.map((s) => `${days[(s.day - w.start + 7) % 7]} ${s.kind}${s.kind === "strength" ? "" : ` ${Math.round(s.minutes)}${s.descentM ? ` ${Math.round(s.descentM)}/${Math.round(s.steepDescentM)}` : ""}`}`).join(", ");
  console.log(`${iso(w.start)}  ${w.phase.padEnd(11)} ${w.chronicAtStart.toFixed(1).padStart(7)} ${w.targetMechanical.toFixed(0).padStart(7)} ${w.plannedMechanical.toFixed(0).padStart(8)} ${(w.plannedMinutes / 60).toFixed(1).padStart(7)}  ${ss}${w.notes.length ? `  [${w.notes.join("; ")}]` : ""}`);
}
console.log(`\nProjected chronic load on race day: ${plan.projectedChronicAtRace.toFixed(1)}`);
console.log(`Comparable past races (0.5-2x the duration): ${plan.comparableRaces.map((c) => `${iso(c.day)} ${(c.movingMin / 60).toFixed(1)} h at chronic ${c.chronicBefore.toFixed(1)}`).join("; ") || "none"}`);
console.log(`Budget binds from: ${plan.budgetBindsFrom === null ? "never" : iso(plan.budgetBindsFrom)}`);
for (const w of plan.warnings) console.log(`WARNING: ${w}`);

// Self-check: every planned run against the per-run guard of everything
// before it, history and plan.
const all = [...history, ...plan.weeks.flatMap((w) => w.sessions.filter((s) => s.kind !== "strength" && s.kind !== "race").map((s) => ({ day: s.day, movingMin: s.minutes, distanceKm: s.distanceKm, descentM: s.descentM, steepDescentM: s.steepDescentM, mechanical: s.mechanical })))];
const { isRace } = runReferences(history);
const nonRace = history.filter((_, i) => !isRace[i]);
let breaches = 0;
for (let i = history.length; i < all.length; i++) {
  const ref = referenceAt([...nonRace, ...all.slice(history.length, i)], all[i].day);
  const b = guardBreaches(all[i], ref);
  if (b.length) { breaches++; console.log(`guard breach ${iso(all[i].day)}: ${b.map((x) => `${x.quantity} x${x.ratio.toFixed(2)}`).join(" ")}`); }
}
console.log(`Guard check: ${breaches} breaches in ${all.length - history.length} planned runs.`);
