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
//   - descent and steep descent progress as their own weekly targets.
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
}

export type Phase = "recovery" | "maintenance" | "base" | "specific" | "deload" | "taper" | "race";
export type SessionKind = "long" | "easy" | "quality" | "descent" | "strength" | "race";

export interface PlannedSession {
  day: number;
  kind: SessionKind;
  minutes: number;
  distanceKm: number;
  mechanical: number;
  descentM: number;
  steepDescentM: number;
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
  sessions: PlannedSession[];
  notes: string[];
}

export interface Plan {
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

const mondayOf = (day: number) => day - ((((day + 3) % 7) + 7) % 7); // 1970-01-01 was a Thursday

export function generatePlan(
  history: HistoryRun[],
  availability: AvailabilitySlot[],
  longRunWeekday: number,
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

  const past = [...history].filter((r) => r.day < today).sort((a, b) => a.day - b.day);
  const { isRace } = runReferences(past);
  const firstDay = past[0]?.day ?? today;
  const planned: HistoryRun[] = [];
  const nonRace = () => [...past.filter((_, i) => !isRace[i]), ...planned];

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
  const firstWeek = mondayOf(today) + 7;
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

  const budgetPerWeek = availability.reduce((s, a) => s + a.minutes, 0);
  const weeks: PlanWeek[] = [];
  let buildCount = 0;
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

    // Each session's allowance on its own day: a big run can age out of the
    // 30-day window between Monday and Saturday. Earlier sessions of the
    // same week aren't counted, which can only make it stricter.
    const runsSoFar = nonRace();
    const allowOn = (day: number) => sessionAllowance(referenceAt(runsSoFar, day));
    const sessions = planWeek(start, phase, target, referenceAt(runsSoFar, start), allowOn, availability, longRunWeekday, race, options, {
      lastWeekDescent, lastWeekSteep, strengthSessions, strengthMinutes,
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
    weeks.push({
      start, phase, chronicAtStart: chronic, targetMechanical: target, plannedMechanical: plannedMech, plannedMinutes: plannedMin,
      budgetMinutes: budgetPerWeek, budgetBinds: binds, sessions, notes,
    });
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
  return { weeks, projectedChronicAtRace, comparableRaces, budgetBindsFrom, warnings };
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
  });

  if (phase === "race") {
    out.push({ day: race.day, kind: "race", minutes: race.expectedHours * 60, distanceKm: 0, mechanical: 0, descentM: race.descentM ?? 0, steepDescentM: race.steepDescentM ?? 0 });
  }
  const slots = [...availability]
    .filter((s) => phase !== "race" || start + s.weekday < race.day - 1)
    .sort((a, b) => (a.weekday === longRunWeekday ? -1 : b.weekday === longRunWeekday ? 1 : b.minutes - a.minutes));

  // Strength first: every week but race week, never on the long-run day
  // or the day before it, spread through the week. Outside the budget (the
  // default) it can go on any such day; inside it, only on slot days, and
  // it takes slot time.
  const strengthWeekdays = phase === "race" ? [] : strengthDaysOf(slots, longRunWeekday, state.strengthSessions, !!o.strengthCountsInBudget);
  for (const wd of strengthWeekdays) {
    out.push({ day: start + wd, kind: "strength", minutes: state.strengthMinutes, distanceKm: 0, mechanical: 0, descentM: 0, steepDescentM: 0 });
  }
  const free = new Map(slots.map((s) => [s.weekday, s.minutes - (o.strengthCountsInBudget && strengthWeekdays.includes(s.weekday) ? state.strengthMinutes : 0)]));

  // Long run: as long as the guard and its slot allow, shorter in lighter
  // weeks.
  const lighter = phase === "recovery" ? 0.5 : phase === "deload" || phase === "maintenance" ? 0.75 : phase === "taper" || phase === "race" ? 0.6 : 1;
  const runs: PlannedSession[] = [];
  const longSlot = slots.find((s) => s.weekday === longRunWeekday);
  let remaining = target;
  if (longSlot) {
    const allow = allowOn(start + longRunWeekday);
    const maxByDistance = (allow.distanceKm / o.speedKmh) * 60;
    const minutes = Math.floor(Math.min(free.get(longRunWeekday)!, allow.movingMin, maxByDistance) * lighter);
    if (minutes >= MIN_RUN_MINUTES) {
      const s = session(start + longRunWeekday, "long", minutes, o.easyDensity);
      runs.push(s);
      remaining -= s.mechanical;
      free.set(longRunWeekday, 0);
    }
  }
  // Other runs: easy at the easy density until the target is met; if the
  // slots run out first, upgrade sessions to quality / descent at higher
  // density (the budget binds).
  for (const slot of slots) {
    if (remaining <= 0) break;
    const allow = allowOn(start + slot.weekday);
    const avail = Math.min(free.get(slot.weekday) ?? 0, allow.movingMin, (allow.distanceKm / o.speedKmh) * 60);
    const minutes = Math.floor(Math.min(avail, (remaining / o.easyDensity) * 60));
    if (minutes < MIN_RUN_MINUTES) continue;
    const s = session(start + slot.weekday, "easy", minutes, o.easyDensity);
    runs.push(s);
    remaining -= s.mechanical;
    free.set(slot.weekday, (free.get(slot.weekday) ?? 0) - minutes);
  }
  if (phase === "base" || phase === "specific") {
    // One quality session per build week (intensity holds fitness when
    // volume is capped), not the day after the long run; in the specific
    // phase one other easy run becomes a descent session (hillier route,
    // easy effort, so easy density).
    const dayAfterLong = start + ((longRunWeekday + 1) % 7);
    const easy = runs.filter((r) => r.kind === "easy").sort((a, b) => b.minutes - a.minutes);
    const quality = easy.find((r) => r.day !== dayAfterLong);
    if (quality) {
      quality.kind = "quality";
      quality.mechanical = (quality.minutes / 60) * o.maxDensity;
    }
    const descent = phase === "specific" ? easy.find((r) => r !== quality) : undefined;
    if (descent) descent.kind = "descent";
  }

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
export function strengthDaysOf(slots: AvailabilitySlot[], longRunWeekday: number, count: number, slotDaysOnly: boolean): number[] {
  const blocked = new Set([longRunWeekday, (longRunWeekday + 6) % 7]);
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

