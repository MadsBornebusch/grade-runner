// PLAN.md §15 layer 4: the plan generator, fixed (prior) ramp first. A pure
// function of the run history, the athlete's weekly availability and the
// goal race, so re-planning after a new activity is just a re-run.
//
// Week by week from the next Monday to race week:
//   - the weekly mechanical target comes from the chronic level the ledger
//     would reach with everything planned so far (same capSpikes + ewma as
//     the ledger), ramped by a fixed % per week, with deloads, recovery
//     weeks after a recent race, and a taper;
//   - hours are a hard cap: every session fits its availability slot. On
//     this athlete's runs load per hour tracks speed (rank correlation
//     0.73), not terrain (-0.19), so the only density lever is intensity:
//     one quality session per build week, never the day after the long run.
//     What that can't make up shows as "budget binds" rather than more
//     intensity (the intensity default leans polarized);
//   - every session is checked against sessionGuard.ts's per-run reference,
//     which includes the sessions planned in earlier weeks;
//   - descent and steep descent progress as their own weekly targets;
//   - once the long run reaches the athlete's longest-run cap, it grows in
//     intensity instead of time: a steady block at race effort near its
//     end, a little longer each capped long run (steadyBlockMinutes).
// Strength sessions are scheduled but carry no running load.
//
// Constants marked "assumption" are starting values to check, not
// findings. The fitted responsiveness (responseModel.ts) failed stage 3's
// bar, so `rampPerWeek` is the prior; it is the hook for scaling later.

import { ACUTE_TAU_DAYS, CHRONIC_TAU_DAYS, capSpikes, ewma } from "./loadLedger";
import { referenceAt, runReferences, sessionAllowance, type GuardRun, type RunReference } from "./sessionGuard";

export interface HistoryRun extends GuardRun {
  /** Mechanical load (loadLedger.ts units). */
  mechanical: number;
}

export interface AvailabilitySlot {
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  minutes: number;
}

/**
 * What the athlete sets (user design, 2026-10-21): a weekly running
 * volume, a preferred long-run day that a given week can move, and the
 * longest long run they can fit (suggestLongRunMaxMinutes proposes one from
 * the race). The other runs are spread over the remaining days.
 */
export interface WeeklySchedule {
  weeklyMinutes: number;
  /** 0 = Monday ... 6 = Sunday. */
  longRunWeekday: number;
  /** Per-week moves of the long run: Monday's day number -> weekday. */
  longRunWeekdayByWeek?: Map<number, number>;
  longRunMaxMinutes: number;
  /** Long runs reach longRunMaxMinutes only every this-many build weeks
   * (long-run weeks; the week's other runs shrink to keep the budget). In
   * the other weeks the long run is held to `normalLongRunShare` of the
   * week. 1 = every build week may reach the max. */
  longRunWeekEvery?: number;
  normalLongRunShare?: number;
  /** Runs per week including the long run. */
  runsPerWeek?: number;
}

/** Assumption: the other runs are at most this long, so the week's volume
 * spreads over several days rather than two long ones. */
const MAX_OTHER_RUN_MINUTES = 75;

/**
 * Assumption, a starting suggestion for the athlete to change: a longest
 * training run of about 35% of the race's expected duration, between 2 and
 * 5 h, and at most 75% of the weekly volume. Common ultra practice puts
 * the longest runs at a few hours, well short of race duration; no study
 * read so far fixes the share.
 */
export function suggestLongRunMaxMinutes(raceExpectedHours: number, weeklyMinutes: number): number {
  const byRace = Math.min(300, Math.max(120, 0.35 * raceExpectedHours * 60));
  return Math.round(Math.min(byRace, 0.75 * weeklyMinutes) / 15) * 15;
}

/** The week's run days and their caps from the schedule. */
export function slotsForWeek(schedule: WeeklySchedule, weekStart: number, longRunWeek: boolean): { slots: AvailabilitySlot[]; longRunWeekday: number } {
  const longDay = schedule.longRunWeekdayByWeek?.get(weekStart) ?? schedule.longRunWeekday;
  const runs = schedule.runsPerWeek ?? 4;
  const normalLong = Math.min(schedule.longRunMaxMinutes, (schedule.normalLongRunShare ?? 0.5) * schedule.weeklyMinutes);
  const longMinutes = longRunWeek || (schedule.longRunWeekEvery ?? 2) === 1 ? schedule.longRunMaxMinutes : normalLong;
  const others = spreadDays(longDay, runs - 1);
  return {
    longRunWeekday: longDay,
    slots: [{ weekday: longDay, minutes: longMinutes }, ...others.map((weekday) => ({ weekday, minutes: MAX_OTHER_RUN_MINUTES }))],
  };
}

/** Other run days as offsets from the long run, by runs per week: spread
 * through the week, with a short run the day after the long run from 4 a
 * week (for a Saturday long run: 3 a week Tue/Thu, 4 adds Sunday). */
const OTHER_RUN_OFFSETS: number[][] = [[], [], [-3], [-4, -2], [-4, -2, 1], [-5, -3, -1, 1], [-5, -4, -3, -1, 1], [-6, -5, -4, -3, -2, -1]];

function spreadDays(longDay: number, count: number): number[] {
  const offsets = OTHER_RUN_OFFSETS[Math.max(0, Math.min(7, count + 1))];
  // In priority order: a week too light for every day drops the last first.
  return offsets.map((o) => (((longDay + o) % 7) + 7) % 7);
}

export interface GoalRace {
  name: string;
  /** Days since 1970-01-01. */
  day: number;
  expectedHours: number;
  /** Total and steep (< -17%) descent of the course, if known. */
  descentM?: number;
  steepDescentM?: number;
}

export interface PlanOptions {
  /** Assumption: chronic load +5% per build week, about 5% more weekly
   * volume per week once on the ramp (inside the common <= 10%/week
   * guidance). */
  rampPerWeek?: number;
  /** Assumption: every 4th build week is a deload at 70% of the week
   * before. */
  deloadEvery?: number;
  deloadFactor?: number;
  /** Load per hour on easy and on quality (threshold) running. Take them
   * from the athlete's own runs (median and 90th percentile). */
  easyDensity: number;
  maxDensity: number;
  /** Typical km per hour, to turn session minutes into distance. */
  speedKmh: number;
  /** Descent and steep descent per hour the athlete's terrain allows on a
   * descent-focused session. */
  maxDescentPerHour: number;
  maxSteepDescentPerHour: number;
  /** Strength sessions per week, and whether their minutes count inside
   * the availability (PLAN.md: the athlete chooses). */
  strengthSessions?: number;
  strengthMinutes?: number;
  strengthCountsInBudget?: boolean;
  /** Gut training (user request, 2026-10-21): carbs per hour on runs of
   * FUELLED_RUN_MINUTES or more, from what the athlete has shown they can
   * take (their logged intake, or `startGPerH`) up to the race's planned
   * intake, `stepGPerH` more on each such run. Off without a race target. */
  carbs?: { raceGPerH: number; startGPerH?: number; stepGPerH?: number };
  /** Plan the rest of the current week too (from `today`), with the week's
   * budget and target reduced by what's already been run since Monday.
   * Without it the plan starts next Monday. */
  includeCurrentWeek?: boolean;
}

export type Phase = "recovery" | "maintenance" | "base" | "specific" | "deload" | "taper" | "race";
export type SessionKind = "long" | "easy" | "quality" | "descent" | "hike" | "strength" | "race";

/** What a strength session works on (copy in ui/plan/strengthCopy.ts). */
export type StrengthFocus = "general" | "heavy" | "heavyJumps" | "maintenance" | "power" | "circuit" | "deload" | "sharpen";

export interface PlannedSession {
  day: number;
  kind: SessionKind;
  minutes: number;
  distanceKm: number;
  mechanical: number;
  descentM: number;
  steepDescentM: number;
  /** Carbs to take, g per hour (runs of FUELLED_RUN_MINUTES or more). */
  carbsGPerH?: number;
  /** Long runs at the time cap: minutes near the end at steady race effort
   * (up to LT1) rather than easy. The rest of the run stays easy. */
  steadyMinutes?: number;
  /** The session guard's limits on this day: show the session as "N min or
   * M km, whichever comes first" from these, not from the speed estimate. */
  allowance?: RunReference;
  /** Strength sessions: what to work on. */
  strengthFocus?: StrengthFocus;
  /** Weighted uphill hikes: pack weight, % of body weight. */
  packPct?: number;
}

/** Runs this long or longer get a carb target. */
export const FUELLED_RUN_MINUTES = 90;

/**
 * Assumption, for gut training: start at the athlete's demonstrated
 * intake (30 g/h without one) and add 5 g/h on each fuelled run up to the
 * race's planned intake, then hold it there. Studies of "training the gut"
 * (e.g. Costa et al. 2017, two weeks of daily high-carb intake during
 * exercise) found fewer GI symptoms and better absorption; the step size
 * and starting point here are this design's.
 */
export function carbTargets(fuelledRunCount: number, carbs: NonNullable<PlanOptions["carbs"]>): number[] {
  const start = Math.min(carbs.raceGPerH, carbs.startGPerH ?? 30);
  const step = carbs.stepGPerH ?? 5;
  return Array.from({ length: fuelledRunCount }, (_, k) => Math.min(carbs.raceGPerH, start + step * k));
}

export interface PlanWeek {
  /** Monday. */
  start: number;
  phase: Phase;
  /** Chronic mechanical level (per day) at the start of the week. */
  chronicAtStart: number;
  targetMechanical: number;
  plannedMechanical: number;
  plannedMinutes: number;
  budgetMinutes: number;
  /** True when the target needed more than the budget at max density. */
  budgetBinds: boolean;
  /** A long-run week: longer long run, shorter other runs. */
  longRunWeek: boolean;
  sessions: PlannedSession[];
  notes: string[];
}

export interface Plan {
  /** "racePast": the goal race is before today, so there is nothing to
   * plan; the weeks are empty. */
  status: "ok" | "racePast";
  weeks: PlanWeek[];
  /** Chronic mechanical level on race morning if the plan is followed. */
  projectedChronicAtRace: number;
  /** Capped chronic level the day before each past race of 0.5-2x the
   * goal's expected duration: descriptive, until stage 5's readiness. */
  comparableRaces: { day: number; movingMin: number; chronicBefore: number }[];
  /** First week the budget binds, or null. */
  budgetBindsFrom: number | null;
  warnings: string[];
}

/**
 * Assumption, to check against primary sources on post-ultra recovery
 * (PLAN.md §15 "After a race"): easy weeks then maintenance weeks after a
 * race, by its duration.
 */
export function recoveryWeeks(raceMovingMin: number): { easy: number; maintenance: number } {
  if (raceMovingMin < 90) return { easy: 0, maintenance: 0 };
  if (raceMovingMin < 240) return { easy: 1, maintenance: 0 };
  if (raceMovingMin < 600) return { easy: 1, maintenance: 1 };
  return { easy: 2, maintenance: 1 };
}

/**
 * Taper, by race duration: weekly load as a fraction of the last full
 * week, last entry = race week (excluding the race). Bosquet et al. 2007's
 * meta-analysis (pre-planned taper, mostly swimmers, cyclists and runners)
 * found 8-14 days with a 41-60% volume cut, intensity and frequency kept,
 * worked best; the split over two weeks and the ultra/short cut-off are
 * this design's assumption.
 */
export function taperFractions(expectedHours: number): number[] {
  return expectedHours >= 3 ? [0.7, 0.5] : [0.6];
}

/** Assumption: a long run of at least this share of the athlete's
 * longest-run cap counts as at the cap (planned runs are floored to whole
 * minutes, done ones rarely land on the exact minute). */
export const CAPPED_LONG_RUN_SHARE = 0.95;
/**
 * Strength blocks by weeks to race (PLAN.md §15, strength sessions).
 * Uphill Athlete's order: general strength, then max strength, then
 * muscular endurance (ME) for 8-16 weeks before the race; Scott Johnston
 * has most athletes add ME in the last 10-16 weeks. Heavy loads (>= 85%
 * 1RM) improve running economy more than lighter ones or jumps alone
 * (Eihara et al. 2022), and heavy plus jumps improved economy late in a
 * 90 min run (Zanini et al.). The week counts are this design's
 * assumption. Keyed on weeks to race, not plan weeks, so a plan that is
 * regenerated every week still moves through the blocks.
 */
export const ME_WEEKS = 12;
export const GENERAL_STRENGTH_ABOVE_WEEKS = 24;
export type StrengthBlock = "general" | "heavy" | "me";
export function strengthBlockOf(weeksToRace: number): StrengthBlock {
  if (weeksToRace > GENERAL_STRENGTH_ABOVE_WEEKS) return "general";
  return weeksToRace > ME_WEEKS ? "heavy" : "me";
}

/** Assumption: the weighted hike's pack starts at 5% of body weight (iRunFar
 * on Johnston: beginners about 5%, elites 12-15%) and grows 1% every two
 * weeks of the ME block, capped at 10% (a 2023 study cited there found
 * more than 10% changed trail runners' biomechanics). */
export function hikePackPct(weeksToRace: number): number {
  const into = Math.max(0, ME_WEEKS - weeksToRace);
  return Math.min(10, 5 + Math.floor(into / 2));
}

/** Strength focus of each of the week's sessions, in day order. Uphill
 * Athlete does ME once a week, so a week with the hike doesn't also get
 * the gym circuit; one heavy set a week keeps strength (Spiering et al.
 * 2021). Nothing in race week, one short session in the taper week before
 * it, one in a deload, none in the easy weeks after a race. */
export function strengthFocuses(phase: Phase, block: StrengthBlock, count: number, hasHike: boolean): StrengthFocus[] {
  let list: StrengthFocus[];
  switch (phase) {
    case "race":
    case "recovery":
      return [];
    case "taper":
      list = ["sharpen"];
      break;
    case "maintenance":
      list = ["maintenance"];
      break;
    case "deload":
      list = [block === "general" ? "general" : "deload"];
      break;
    default:
      list = block === "general" ? ["general", "general"] : block === "heavy" ? ["heavy", "heavyJumps"] : hasHike ? ["maintenance", "power"] : ["circuit", "maintenance"];
      return Array.from({ length: count }, (_, i) => list[i % list.length]);
  }
  return list.slice(0, Math.min(count, list.length));
}

/** Assumption: capped long runs at most this many days apart form one
 * progression; a longer gap (illness, a race, a break) starts it over.
 * Long enough for a deload between two long-run weeks. */
const STEADY_STREAK_GAP_DAYS = 28;
/** Assumptions: the steady block grows 10 min per earlier capped long run
 * in the streak, up to a third of the run and at most an hour, so the
 * first capped long run is all easy. */
const STEADY_STEP_MINUTES = 10;
const STEADY_MAX_SHARE = 1 / 3;
const STEADY_MAX_MINUTES = 60;
/** Assumption: race effort sits a quarter of the way from easy to
 * threshold density. For a long race it is at or below LT1, so the block
 * adds little load; its point is race-specific running on tired legs. */
const STEADY_DENSITY_SHARE = 0.25;

/**
 * Minutes of steady running in a long run of `minutes` on `day`, given the
 * days of earlier capped long runs (done or planned). Zero below the cap:
 * time on feet comes first, intensity only once time can't grow.
 */
export function steadyBlockMinutes(day: number, minutes: number, capMinutes: number, cappedDays: number[]): number {
  if (minutes < CAPPED_LONG_RUN_SHARE * capMinutes) return 0;
  let streak = 0;
  let after = day;
  for (const d of [...cappedDays].filter((x) => x < day).sort((a, b) => b - a)) {
    if (after - d > STEADY_STREAK_GAP_DAYS) break;
    streak++;
    after = d;
  }
  const block = Math.min(STEADY_STEP_MINUTES * streak, STEADY_MAX_SHARE * minutes, STEADY_MAX_MINUTES);
  return Math.floor(block / 5) * 5;
}

export const mondayOf = (day: number) => day - ((((day + 3) % 7) + 7) % 7); // 1970-01-01 was a Thursday

export function generatePlan(
  history: HistoryRun[],
  schedule: WeeklySchedule,
  race: GoalRace,
  today: number,
  options: PlanOptions,
): Plan {
  const ramp = options.rampPerWeek ?? 0.05;
  const deloadEvery = options.deloadEvery ?? 4;
  const deloadFactor = options.deloadFactor ?? 0.7;
  const strengthSessions = options.strengthSessions ?? 2;
  const strengthMinutes = options.strengthMinutes ?? 25;
  const warnings: string[] = [];

  if (race.day < today) {
    return { status: "racePast", weeks: [], projectedChronicAtRace: 0, comparableRaces: [], budgetBindsFrom: null, warnings: [] };
  }
  const past = [...history].filter((r) => r.day < today).sort((a, b) => a.day - b.day);
  const { isRace } = runReferences(past);
  const firstDay = past[0]?.day ?? today;
  const planned: HistoryRun[] = [];
  const nonRace = () => [...past.filter((_, i) => !isRace[i]), ...planned];
  // Long runs at the time cap so far, done then planned, for the steady
  // block's progression.
  const cappedDays = past.filter((r, i) => !isRace[i] && r.movingMin >= CAPPED_LONG_RUN_SHARE * schedule.longRunMaxMinutes).map((r) => r.day);

  // Daily mechanical series from the first run to `upTo` (exclusive),
  // history plus planned sessions, capped like the ledger.
  const chronicBefore = (upTo: number) => {
    const n = Math.max(0, upTo - firstDay);
    const daily = new Array<number>(n).fill(0);
    for (const r of [...past, ...planned]) if (r.day >= firstDay && r.day < upTo) daily[r.day - firstDay] += r.mechanical;
    const c = ewma(capSpikes(daily), CHRONIC_TAU_DAYS);
    return { chronic: c.at(-1) ?? 0, acute: ewma(capSpikes(daily), ACUTE_TAU_DAYS).at(-1) ?? 0 };
  };

  // Most recent race, for recovery weeks.
  const lastRaceIdx = isRace.lastIndexOf(true);
  const lastRace = lastRaceIdx >= 0 ? past[lastRaceIdx] : null;
  const firstWeek = mondayOf(today) + (options.includeCurrentWeek ? 0 : 7);
  const raceWeek = mondayOf(race.day);
  let recoveryEasy = 0;
  let recoveryMaintenance = 0;
  if (lastRace) {
    const rec = recoveryWeeks(lastRace.movingMin);
    const weeksSince = Math.floor((firstWeek - mondayOf(lastRace.day)) / 7) - 1;
    recoveryEasy = Math.max(0, rec.easy - weeksSince);
    recoveryMaintenance = Math.max(0, rec.maintenance - Math.max(0, weeksSince - rec.easy));
  }

  const taper = taperFractions(race.expectedHours);
  const nWeeks = Math.floor((raceWeek - firstWeek) / 7) + 1;
  if (nWeeks < 1) throw new Error("race is before the first plan week");
  if (nWeeks < taper.length + 1) warnings.push("Too few weeks before the race for a build; the plan is taper only.");
  const specificWeeks = 6;

  const budgetPerWeek = schedule.weeklyMinutes;
  const weeks: PlanWeek[] = [];
  let buildCount = 0;
  let longRunCount = 0;
  let prevLongDay: number | null = null;
  // Long-run weeks (user idea, 2026-10-21): the long run is the most
  // race-specific session (time on feet, fuelling practice), so every
  // longRunWeekEvery-th build week it may reach the schedule's max while
  // the other runs shrink to keep the week within budget.
  const longRunWeekEvery = schedule.longRunWeekEvery ?? 2;
  let lastFullWeekMech = 0;
  let lastWeekDescent: number | null = null;
  let lastWeekSteep: number | null = null;
  let budgetBindsFrom: number | null = null;

  for (let w = 0; w < nWeeks; w++) {
    const start = firstWeek + 7 * w;
    const weeksToRace = nWeeks - 1 - w;
    const { chronic } = chronicBefore(start);
    let phase: Phase;
    if (weeksToRace === 0) phase = "race";
    else if (weeksToRace < taper.length) phase = "taper";
    else if (w < recoveryEasy) phase = "recovery";
    else if (w < recoveryEasy + recoveryMaintenance) phase = "maintenance";
    else {
      buildCount++;
      phase = buildCount % deloadEvery === 0 ? "deload" : weeksToRace < taper.length + specificWeeks ? "specific" : "base";
    }
    const notes: string[] = [];
    const longRunWeek = (phase === "base" || phase === "specific") && ++longRunCount % longRunWeekEvery === 0 && longRunWeekEvery > 1;
    if (longRunWeek) notes.push("long-run week");
    const { slots: availability, longRunWeekday } = slotsForWeek(schedule, start, longRunWeek);
    let target: number;
    if (phase === "recovery") target = 0.5 * 7 * chronic;
    else if (phase === "maintenance") target = 7 * chronic;
    else if (phase === "deload") target = deloadFactor * (lastFullWeekMech || 7 * chronic);
    else if (phase === "taper" || phase === "race") {
      const k = phase === "race" ? taper.length - 1 : taper.length - 1 - weeksToRace;
      target = taper[Math.max(0, k)] * (lastFullWeekMech || 7 * chronic);
    } else {
      // Daily load x needed to raise the 42-day EWMA by ramp x chronic over
      // 7 days: c + 7 (x - c) / 42 = c (1 + ramp)  =>  x = c (1 + 6 ramp).
      target = 7 * chronic * (1 + (ramp * CHRONIC_TAU_DAYS) / 7);
    }
    // The current week (includeCurrentWeek): what's been run since Monday
    // counts against the week's target and budget, and only today onward
    // gets sessions.
    const doneThisWeek = past.filter((r) => r.day >= start && r.day < start + 7);
    const doneMinutes = doneThisWeek.reduce((a, r) => a + r.movingMin, 0);
    target = Math.max(0, target - doneThisWeek.reduce((a, r) => a + r.mechanical, 0));

    // Each session's allowance on its own day: a big run can age out of the
    // 30-day window between Monday and Saturday. Earlier sessions of the
    // same week aren't counted, which can only make it stricter.
    const runsSoFar = nonRace();
    const allowOn = (day: number) => sessionAllowance(referenceAt(runsSoFar, day));
    const sessions = planWeek(start, phase, target, referenceAt(runsSoFar, start), allowOn, availability, longRunWeekday, race, options, {
      lastWeekDescent, lastWeekSteep, strengthSessions, strengthMinutes, budgetMinutes: Math.max(0, budgetPerWeek - doneMinutes), fromDay: today,
      prevLongDay, nextLongDay: start + 7 + (schedule.longRunWeekdayByWeek?.get(start + 7) ?? schedule.longRunWeekday),
      longRunCapMinutes: schedule.longRunMaxMinutes, cappedDays, weeksToRace,
    });
    const plannedMech = sessions.reduce((s, x) => s + x.mechanical, 0);
    const plannedMin = sessions
      .filter((x) => x.kind !== "race" && (x.kind !== "strength" || options.strengthCountsInBudget))
      .reduce((s, x) => s + x.minutes, 0);
    // Only a build week can bind: lighter weeks are short by design.
    const binds = (phase === "base" || phase === "specific") && plannedMech < target - 1e-6;
    if (binds) {
      notes.push(`budget binds: ${Math.round(plannedMech)} of ${Math.round(target)} load within ${Math.round(budgetPerWeek / 60 * 10) / 10} h`);
      if (budgetBindsFrom === null) budgetBindsFrom = start;
    }
    for (const s of sessions) {
      if (s.kind === "strength" || s.kind === "race") continue;
      planned.push({ day: s.day, movingMin: s.minutes, distanceKm: s.distanceKm, descentM: s.descentM, steepDescentM: s.steepDescentM, mechanical: s.mechanical });
    }
    if (phase === "base" || phase === "specific") lastFullWeekMech = plannedMech;
    const runs = sessions.filter((s) => s.kind !== "strength" && s.kind !== "race");
    lastWeekDescent = runs.reduce((s, x) => s + x.descentM, 0);
    lastWeekSteep = runs.reduce((s, x) => s + x.steepDescentM, 0);
    const long = sessions.find((x) => x.kind === "long");
    prevLongDay = long?.day ?? null;
    if (long && long.minutes >= CAPPED_LONG_RUN_SHARE * schedule.longRunMaxMinutes) cappedDays.push(long.day);
    weeks.push({
      start, phase, chronicAtStart: chronic, targetMechanical: target, plannedMechanical: plannedMech, plannedMinutes: plannedMin,
      budgetMinutes: budgetPerWeek, budgetBinds: binds, longRunWeek, sessions, notes,
    });
  }

  if (options.carbs) {
    const fuelled = weeks.flatMap((w) => w.sessions).filter((x) => x.kind !== "race" && x.kind !== "strength" && x.minutes >= FUELLED_RUN_MINUTES);
    carbTargets(fuelled.length, options.carbs).forEach((g, k) => (fuelled[k].carbsGPerH = g));
    for (const x of weeks.flatMap((w) => w.sessions)) if (x.kind === "race") x.carbsGPerH = options.carbs.raceGPerH;
    const reached = fuelled.findIndex((x) => x.carbsGPerH === options.carbs!.raceGPerH);
    if (reached < 0) {
      warnings.push(`Long runs don't reach the race's planned ${options.carbs.raceGPerH} g/h of carbs before race day (last: ${fuelled.at(-1)?.carbsGPerH ?? "none"} g/h); start higher or plan more long runs.`);
    } else if (race.day - fuelled[reached].day < 28) {
      warnings.push(`The race's planned ${options.carbs.raceGPerH} g/h of carbs is first practised under 4 weeks before race day.`);
    }
  }
  const projectedChronicAtRace = chronicBefore(race.day).chronic;
  const longest = Math.max(0, ...weeks.flatMap((w) => w.sessions.filter((x) => x.kind === "long").map((x) => x.minutes)));
  if (longest < LONG_RUN_RACE_SHARE * race.expectedHours * 60) {
    warnings.push(
      `The longest planned run (${(longest / 60).toFixed(1)} h) is under ${Math.round(100 * LONG_RUN_RACE_SHARE)}% of the race's expected ${race.expectedHours} h; ` +
        "a longer weekend slot, or borrowing hours between weeks, would let it grow.",
    );
  }
  const comparableRaces = past
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => isRace[i] && r.movingMin >= 0.5 * race.expectedHours * 60 && r.movingMin <= 2 * race.expectedHours * 60)
    .map(({ r }) => ({ day: r.day, movingMin: r.movingMin, chronicBefore: chronicOfHistory(past, firstDay, r.day) }));
  if (comparableRaces.length) {
    const best = Math.max(...comparableRaces.map((c) => c.chronicBefore));
    if (projectedChronicAtRace < 0.9 * best) {
      warnings.push(`Projected chronic load on race day (${projectedChronicAtRace.toFixed(0)}) is below the level before comparable past races (up to ${best.toFixed(0)}).`);
    }
  }
  return { status: "ok", weeks, projectedChronicAtRace, comparableRaces, budgetBindsFrom, warnings };
}

function chronicOfHistory(runs: HistoryRun[], firstDay: number, upTo: number): number {
  const daily = new Array<number>(Math.max(0, upTo - firstDay)).fill(0);
  for (const r of runs) if (r.day >= firstDay && r.day < upTo) daily[r.day - firstDay] += r.mechanical;
  return ewma(capSpikes(daily), CHRONIC_TAU_DAYS).at(-1) ?? 0;
}

interface WeekState {
  lastWeekDescent: number | null;
  lastWeekSteep: number | null;
  strengthSessions: number;
  strengthMinutes: number;
  /** The week's running budget, which the slots may add up to more than. */
  budgetMinutes: number;
  /** No session before this day (today, for the current week). */
  fromDay: number;
  /** Last week's long-run day and next week's planned one (absolute days),
   * so "the day after / before the long run" works across week ends. */
  prevLongDay: number | null;
  nextLongDay: number;
  longRunCapMinutes: number;
  cappedDays: number[];
  weeksToRace: number;
}

/** Assumption: weekly descent and steep descent grow at most 10% a week
 * (from last week's, or from one session's allowance if that is more), the
 * same step as the session guard. */
const DESCENT_WEEKLY_STEP = 1.1;
/** Assumption: a longest training run under this share of the race's
 * expected duration is worth a warning. */
const LONG_RUN_RACE_SHARE = 0.4;
/** Shortest run worth scheduling. */
const MIN_RUN_MINUTES = 25;

function planWeek(
  start: number,
  phase: Phase,
  target: number,
  ref: RunReference,
  allowOn: (day: number) => RunReference,
  availability: AvailabilitySlot[],
  longRunWeekday: number,
  race: GoalRace,
  o: PlanOptions,
  state: WeekState,
): PlannedSession[] {
  const out: PlannedSession[] = [];
  const session = (day: number, kind: SessionKind, minutes: number, density: number): PlannedSession => ({
    day, kind, minutes, distanceKm: Math.min((minutes / 60) * o.speedKmh, allowOn(day).distanceKm), mechanical: (minutes / 60) * density, descentM: 0, steepDescentM: 0,
    allowance: allowOn(day),
  });

  if (phase === "race") {
    out.push({ day: race.day, kind: "race", minutes: race.expectedHours * 60, distanceKm: 0, mechanical: 0, descentM: race.descentM ?? 0, steepDescentM: race.steepDescentM ?? 0 });
  }
  const slots = [...availability]
    .filter((s) => (phase !== "race" || start + s.weekday < race.day - 1) && start + s.weekday >= state.fromDay)
    .sort((a, b) => (a.weekday === longRunWeekday ? -1 : b.weekday === longRunWeekday ? 1 : b.minutes - a.minutes));

  // Strength first: as many sessions as the phase wants (strengthFocuses),
  // never on the long-run day or the day before it, spread through the
  // week. Outside the budget (the default) it can go on any such day;
  // inside it, only on slot days, and it takes slot time. The focus of
  // each is set at the end, once it's known whether the week has a hike.
  const block = strengthBlockOf(state.weeksToRace);
  const isBuild = phase === "base" || phase === "specific";
  const hikeWeek = isBuild && block === "me";
  const strengthCount = strengthFocuses(phase, block, state.strengthSessions, hikeWeek).length;
  const dayBeforeNextLong = state.nextLongDay - 1 - start;
  // The taper's one session goes early in the week, away from the race.
  const strengthWeekdays =
    phase === "taper"
      ? strengthDaysOf(slots, longRunWeekday, 7, !!o.strengthCountsInBudget, [dayBeforeNextLong]).slice(0, strengthCount)
      : strengthDaysOf(slots, longRunWeekday, strengthCount, !!o.strengthCountsInBudget, dayBeforeNextLong >= 0 && dayBeforeNextLong < 7 ? [dayBeforeNextLong] : []);
  const strengthSessions: PlannedSession[] = [];
  for (const wd of strengthWeekdays) {
    if (start + wd < state.fromDay) continue;
    strengthSessions.push({ day: start + wd, kind: "strength", minutes: state.strengthMinutes, distanceKm: 0, mechanical: 0, descentM: 0, steepDescentM: 0 });
  }
  out.push(...strengthSessions);
  const free = new Map(slots.map((s) => [s.weekday, s.minutes - (o.strengthCountsInBudget && strengthWeekdays.includes(s.weekday) ? state.strengthMinutes : 0)]));

  // Long run: as long as the guard and its slot allow, shorter in lighter
  // weeks.
  const lighter = phase === "recovery" ? 0.5 : phase === "deload" || phase === "maintenance" ? 0.75 : phase === "taper" || phase === "race" ? 0.6 : 1;
  const runs: PlannedSession[] = [];
  const longSlot = slots.find((s) => s.weekday === longRunWeekday);
  let remaining = target;
  // The week's running minutes never exceed the budget, even when a
  // long-run week lets the long run past its own slot.
  let weekLeft = state.budgetMinutes - (o.strengthCountsInBudget ? strengthWeekdays.length * state.strengthMinutes : 0);
  if (longSlot) {
    const allow = allowOn(start + longRunWeekday);
    const maxByDistance = (allow.distanceKm / o.speedKmh) * 60;
    const minutes = Math.floor(Math.min(free.get(longRunWeekday)!, weekLeft, allow.movingMin, maxByDistance) * lighter);
    if (minutes >= MIN_RUN_MINUTES) {
      const s = session(start + longRunWeekday, "long", minutes, o.easyDensity);
      // Build weeks only: lighter weeks and the taper keep it all easy.
      const steady = phase === "base" || phase === "specific" ? steadyBlockMinutes(s.day, minutes, state.longRunCapMinutes, state.cappedDays) : 0;
      if (steady > 0) {
        s.steadyMinutes = steady;
        s.mechanical += (steady / 60) * STEADY_DENSITY_SHARE * (o.maxDensity - o.easyDensity);
      }
      runs.push(s);
      remaining -= s.mechanical;
      weekLeft -= minutes;
      free.set(longRunWeekday, 0);
    }
  }
  // Other runs: the minutes the target still needs (at easy density, at
  // most what the budget has left), split evenly over the other run days,
  // using fewer days when an even split would make runs too short. A run
  // that hits its day's cap leaves its share to the others.
  const others = slots.filter((x) => x.weekday !== longRunWeekday);
  const capOf = (slot: AvailabilitySlot) => {
    const allow = allowOn(start + slot.weekday);
    return Math.min(free.get(slot.weekday) ?? 0, allow.movingMin, (allow.distanceKm / o.speedKmh) * 60);
  };
  let wanted = Math.max(0, Math.min(weekLeft, (remaining / o.easyDensity) * 60));
  let use = others.length;
  while (use > 1 && wanted / use < MIN_RUN_MINUTES) use--;
  const chosen = others.slice(0, use);
  const minutesFor = new Map<number, number>();
  let open = chosen.filter((x) => capOf(x) > 0);
  while (open.length && wanted > 1e-9) {
    const share = wanted / open.length;
    const capped = open.filter((x) => capOf(x) - (minutesFor.get(x.weekday) ?? 0) <= share);
    if (!capped.length) {
      for (const x of open) minutesFor.set(x.weekday, (minutesFor.get(x.weekday) ?? 0) + share);
      wanted = 0;
      break;
    }
    for (const x of capped) {
      wanted -= capOf(x) - (minutesFor.get(x.weekday) ?? 0);
      minutesFor.set(x.weekday, capOf(x));
    }
    open = open.filter((x) => !capped.includes(x));
  }
  for (const slot of chosen) {
    const minutes = Math.floor(minutesFor.get(slot.weekday) ?? 0);
    if (minutes < MIN_RUN_MINUTES) continue;
    const s = session(start + slot.weekday, "easy", minutes, o.easyDensity);
    runs.push(s);
    remaining -= s.mechanical;
    weekLeft -= minutes;
  }
  let hasHike = false;
  if (isBuild) {
    // One quality session per build week (intensity holds fitness when
    // volume is capped), not the day after the long run, and preferably
    // not the day after strength; in the specific phase one other easy run
    // becomes a descent session (hillier route, easy effort, so easy
    // density); in the ME block one more becomes a weighted uphill hike
    // (time on feet, easy breathing, so easy density), preferably not the
    // day before or after the long run, then not on a strength day. A week short of runs drops the hike first,
    // then the descent.
    const afterLong = new Set([start + longRunWeekday + 1, (state.prevLongDay ?? -Infinity) + 1]);
    const afterStrength = new Set(strengthSessions.map((x) => x.day + 1));
    const easy = runs.filter((r) => r.kind === "easy").sort((a, b) => b.minutes - a.minutes);
    const qualityOk = easy.filter((r) => !afterLong.has(r.day));
    const quality = qualityOk.find((r) => !afterStrength.has(r.day)) ?? qualityOk[0];
    if (quality) {
      quality.kind = "quality";
      quality.mechanical = (quality.minutes / 60) * o.maxDensity;
    }
    const descent = phase === "specific" ? easy.find((r) => r !== quality) : undefined;
    if (descent) descent.kind = "descent";
    if (hikeWeek) {
      const left = easy.filter((r) => r !== quality && r !== descent);
      const strengthDays = new Set(strengthSessions.map((x) => x.day));
      const nearLong = new Set([state.nextLongDay - 1, start + longRunWeekday - 1, ...afterLong]);
      const awayFromLong = left.filter((r) => !nearLong.has(r.day));
      const hike = awayFromLong.find((r) => !strengthDays.has(r.day)) ?? awayFromLong[0] ?? left.find((r) => !strengthDays.has(r.day)) ?? left[0];
      if (hike) {
        hike.kind = "hike";
        hike.packPct = hikePackPct(state.weeksToRace);
        hasHike = true;
      }
    }
  }
  const focuses = strengthFocuses(phase, block, state.strengthSessions, hasHike);
  strengthSessions.forEach((x, i) => (x.strengthFocus = focuses[i]));

  // Descent: progress the week's total from last week's (or the reference)
  // by at most 10%, each session within its own allowance.
  const weekAllow = allowOn(start);
  const weekDescentCap = state.lastWeekDescent === null ? 2 * ref.descentM : DESCENT_WEEKLY_STEP * Math.max(state.lastWeekDescent, weekAllow.descentM);
  const weekSteepCap = state.lastWeekSteep === null ? 2 * ref.steepDescentM : DESCENT_WEEKLY_STEP * Math.max(state.lastWeekSteep, weekAllow.steepDescentM);
  let descentLeft = phase === "recovery" ? 0 : weekDescentCap * lighter;
  let steepLeft = phase === "recovery" ? 0 : weekSteepCap * lighter;
  const order = [...runs].sort((a, b) => rank(a.kind) - rank(b.kind));
  for (const r of order) {
    const hours = r.minutes / 60;
    const allow = allowOn(r.day);
    const perHour = r.kind === "descent" ? 1 : r.kind === "long" ? 0.6 : 0.3;
    r.descentM = Math.min(descentLeft, allow.descentM, perHour * o.maxDescentPerHour * hours);
    r.steepDescentM = Math.min(steepLeft, allow.steepDescentM, r.descentM, perHour * o.maxSteepDescentPerHour * hours);
    descentLeft -= r.descentM;
    steepLeft -= r.steepDescentM;
  }
  return [...out, ...runs].sort((a, b) => a.day - b.day);
}

/** `count` weekdays for strength, avoiding the long-run day and the day
 * before it, as far apart as possible (preferring days with a run slot,
 * so strength can follow an easy run). */
export function strengthDaysOf(
  slots: AvailabilitySlot[],
  longRunWeekday: number,
  count: number,
  slotDaysOnly: boolean,
  alsoBlocked: number[] = [],
): number[] {
  const blocked = new Set([longRunWeekday, (longRunWeekday + 6) % 7, ...alsoBlocked]);
  const slotDays = new Set(slots.map((x) => x.weekday));
  const candidates = [0, 1, 2, 3, 4, 5, 6].filter((d) => !blocked.has(d) && (!slotDaysOnly || slotDays.has(d)));
  const chosen: number[] = [];
  const gap = (d: number) => (chosen.length ? Math.min(...chosen.map((c) => Math.min((d - c + 7) % 7, (c - d + 7) % 7))) : 0);
  while (chosen.length < count && chosen.length < candidates.length) {
    const next = candidates
      .filter((d) => !chosen.includes(d))
      .sort((a, b) => gap(b) - gap(a) || Number(slotDays.has(b)) - Number(slotDays.has(a)) || a - b)[0];
    chosen.push(next);
  }
  return chosen.sort((a, b) => a - b);
}

const rank = (k: SessionKind) => (k === "descent" ? 0 : k === "long" ? 1 : 2);

