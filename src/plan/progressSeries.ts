// The Progress page's series (ui/plan/ProgressView.tsx): how much training
// the athlete has done, from the run history alone, so it reaches back as
// far as the history does.
//
// Load is runningImpact's mechanical score, the same quantity the plan
// generator prescribes from, smoothed with the generator's fixed EWMAs
// (loadLedger.ts) and shown per week (7 x the daily level). The display
// uses the raw series, not capSpikes's: a race shows as the jump it was
// (loadLedger.ts: "Validate and display the raw series").
import { ACUTE_TAU_DAYS, CHRONIC_TAU_DAYS, ewma } from "./loadLedger";
import { mondayOf, type HistoryRun, type Phase, type PlanWeek } from "./planGenerator";

export interface LoadPoint {
  day: number;
  /** 42-day level, per week. */
  longTerm: number;
  /** 7-day level, per week. */
  recent: number;
}

/** Daily levels from the first run to `today` (inclusive), returned from
 * `fromDay` on. The EWMAs start at zero on the first run, so a window that
 * begins well after it has no warm-up ramp. */
export function loadSeries(history: Pick<HistoryRun, "day" | "mechanical">[], today: number, fromDay: number): LoadPoint[] {
  if (history.length === 0) return [];
  const first = Math.min(...history.map((r) => r.day));
  const daily = new Array<number>(Math.max(0, today - first + 1)).fill(0);
  for (const r of history) if (r.day >= first && r.day <= today) daily[r.day - first] += r.mechanical;
  const long = ewma(daily, CHRONIC_TAU_DAYS);
  const recent = ewma(daily, ACUTE_TAU_DAYS);
  const out: LoadPoint[] = [];
  for (let i = Math.max(0, fromDay - first); i < daily.length; i++) out.push({ day: first + i, longTerm: 7 * long[i], recent: 7 * recent[i] });
  return out;
}

export interface WeekTotals {
  /** Monday. */
  start: number;
  hours: number;
  km: number;
  runs: number;
  descentM: number;
  climbM: number;
}

/** Totals per week for the `weeks` weeks up to and including today's.
 * `hills` adds climb and descent only (Strava hikes, planFromSettings.ts's
 * hikeHillRuns): no time, distance or run count. */
export function weeklyTotals(
  history: Pick<HistoryRun, "day" | "movingMin" | "distanceKm" | "descentM" | "climbM">[],
  hills: Pick<HistoryRun, "day" | "descentM" | "climbM">[],
  today: number,
  weeks: number,
): WeekTotals[] {
  const last = mondayOf(today);
  const out: WeekTotals[] = Array.from({ length: weeks }, (_, i) => ({ start: last - 7 * (weeks - 1 - i), hours: 0, km: 0, runs: 0, descentM: 0, climbM: 0 }));
  const weekOf = (day: number) => (day > today ? undefined : out[(mondayOf(day) - out[0].start) / 7]);
  for (const r of history) {
    const w = weekOf(r.day);
    if (!w) continue;
    w.hours += r.movingMin / 60;
    w.km += r.distanceKm;
    w.runs += 1;
    w.descentM += r.descentM;
    w.climbM += r.climbM;
  }
  for (const h of hills) {
    const w = weekOf(h.day);
    if (!w) continue;
    w.descentM += h.descentM;
    w.climbM += h.climbM;
  }
  return out;
}

/** Relative change of the long-term level over the last `days` days, or
 * null when there's no level to compare against. */
export function longTermChange(series: LoadPoint[], days: number): number | null {
  const now = series.at(-1);
  const then = series.at(-1 - days);
  if (!now || !then || !(then.longTerm > 0)) return null;
  return now.longTerm / then.longTerm - 1;
}

/** Weeks summed by the month their Monday falls in (`start` is then the
 * first such Monday), for ranges too long for one bar per week. */
export function byMonth(weeks: WeekTotals[], monthOf: (day: number) => string): WeekTotals[] {
  const out: WeekTotals[] = [];
  let key: string | null = null;
  for (const w of weeks) {
    const k = monthOf(w.start);
    if (k !== key) {
      out.push({ ...w });
      key = k;
      continue;
    }
    const m = out[out.length - 1];
    m.hours += w.hours;
    m.km += w.km;
    m.runs += w.runs;
    m.descentM += w.descentM;
    m.climbM += w.climbM;
  }
  return out;
}

export interface PhaseBand {
  /** First day, and the day after the last. */
  from: number;
  to: number;
  phase: Phase;
}

/**
 * Weeks shaded by phase between `from` and `to`: past weeks from the log
 * (Mondays by day number), this week and later from the plan, which wins
 * where both have a week. Neighbouring weeks of one phase merge into one
 * band; bands are clipped to the window.
 */
export function phaseBands(logged: Map<number, Phase>, weeks: Pick<PlanWeek, "start" | "phase">[], from: number, to: number): PhaseBand[] {
  const byWeek = new Map(logged);
  for (const w of weeks) byWeek.set(w.start, w.phase);
  const out: PhaseBand[] = [];
  for (const [start, phase] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    const a = Math.max(start, from);
    const b = Math.min(start + 7, to);
    if (a >= b) continue;
    const last = out.at(-1);
    if (last && last.phase === phase && last.to === a) last.to = b;
    else out.push({ from: a, to: b, phase });
  }
  return out;
}

/**
 * The 6-week level ahead if the plan is followed, per week (7 x the daily
 * level, like loadSeries), from `today` to the race. The plan's levels are
 * the generator's spike-capped ones, so they're moved to start at the
 * displayed level today: only the plan's change from this week is used.
 */
export function planProjection(
  weeks: Pick<PlanWeek, "start" | "chronicAtStart">[],
  today: number,
  longTermToday: number,
  race?: { day: number; chronic: number },
): { day: number; plan: number }[] {
  const current = weeks.find((w) => w.start <= today && today < w.start + 7);
  if (!current) return [];
  const at = (chronic: number) => Math.max(0, longTermToday + 7 * (chronic - current.chronicAtStart));
  const out = [{ day: today, plan: longTermToday }];
  for (const w of weeks) if (w.start > today && (!race || w.start < race.day)) out.push({ day: w.start, plan: at(w.chronicAtStart) });
  if (race && race.day > today) out.push({ day: race.day, plan: at(race.chronic) });
  return out;
}
