// The fitness index's per-run summaries from the stored runs, in the
// browser (scripts/planRunData.ts does the same from the Strava cache).
// Each run goes through the course pipeline and the run analysis (tens of
// ms), so results are cached in localStorage per run, like historyCache.ts.
import { runPipeline } from "../gpx/pipeline";
import { analyzeRun } from "../model/analysis";
import type { CeilingParams } from "../model/ceiling";
import { buildEffortTrendPoints } from "../model/pacingFit";
import { runningImpact } from "../model/runningImpact";
import type { StoredRun } from "../storage/runLibrary";
import { compactSummary, FLAT_MAX_GRADE, FLAT_WINDOW_S, flatSampleMask, FROZEN_MIN_SAMPLE_MIN, summarizeRunSamples, type CompactRunSummary } from "./fitnessIndex";
import { activityLoadFromSummary } from "./loadLedger";

/** Runs shorter than this give no reading (the stage 2 data set). */
export const MIN_FITNESS_RUN_MIN = 30;

/** Null when the run can't give a reading: no track, too short, under 80%
 * of points with HR, indoor, bad elevation (points-based load more than
 * 1.5x the summary estimate) or too little flat running. */
export function fitnessSummaryFromStored(run: StoredRun, bodyMassKg: number, ceilingParams: CeilingParams): CompactRunSummary | null {
  const points = run.points;
  if (!points || points.length < 2 || run.indoor || (run.durationS ?? 0) < MIN_FITNESS_RUN_MIN * 60) return null;
  if (points.filter((p) => p.hr).length < 0.8 * points.length) return null;
  const course = runPipeline(points);
  if (!course.hasTimestamps || !course.hasElevation) return null;
  const summary = activityLoadFromSummary({
    activityId: run.id, date: "", distanceKm: run.distanceKm ?? course.totalDistance3D / 1000, elevationGainM: run.elevationGainM ?? course.totalElevationGain,
    movingS: run.durationS ?? 0, thresholdGrossPowerWPerKg: 15,
  });
  if (summary.mechanical > 0 && runningImpact(course.segments) / summary.mechanical > 1.5) return null;
  const analysis = analyzeRun(course.segments, { bodyMassKg, ceilingParams, fueling: { intakeGPerH: 0 }, glycogenStoreG: 1e9 });
  const trend = buildEffortTrendPoints(course.segments, analysis.segments, true);
  const trendSegments = analysis.segments.filter((s) => s.effortFraction !== null).map((s) => course.segments[s.index]);
  const flat = flatSampleMask(trend, trendSegments.map((seg) => seg?.gradient ?? 0), FLAT_MAX_GRADE, FLAT_WINDOW_S);
  const s = summarizeRunSamples(trend, (i) => flat[i], FROZEN_MIN_SAMPLE_MIN);
  return s && compactSummary(s);
}

const CACHE_VERSION = 1;
const CACHE_KEY = "grade-runner.fitnessCache.v1";
const CHUNK = 4;

type Cache = { version: number; byKey: Record<string, CompactRunSummary | null> };

const keyOf = (run: StoredRun) => `${run.id}:${run.points?.length ?? 0}:${run.durationS ?? ""}:${run.indoor ? "i" : ""}`;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const cache = raw ? (JSON.parse(raw) as Cache) : null;
    if (cache && cache.version === CACHE_VERSION) return cache;
  } catch {
    // Rebuilt below.
  }
  return { version: CACHE_VERSION, byKey: {} };
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Summaries for every stored run that gives one, by run id. Only runs
 * with points are processed; `onProgress` counts the uncached ones. */
export async function buildFitnessSummaries(
  runs: StoredRun[],
  bodyMassKg: number,
  ceilingParams: CeilingParams,
  onProgress?: (done: number, total: number) => void,
  cancelled: () => boolean = () => false,
): Promise<Map<string, CompactRunSummary> | null> {
  const cache = readCache();
  const keep: Cache["byKey"] = {};
  const todo: StoredRun[] = [];
  for (const run of runs) {
    if (!run.points?.length) continue;
    const key = keyOf(run);
    if (key in cache.byKey) keep[key] = cache.byKey[key];
    else todo.push(run);
  }
  for (let i = 0; i < todo.length; i += CHUNK) {
    if (cancelled()) return null;
    for (const run of todo.slice(i, i + CHUNK)) {
      try {
        keep[keyOf(run)] = fitnessSummaryFromStored(run, bodyMassKg, ceilingParams);
      } catch {
        keep[keyOf(run)] = null;
      }
    }
    onProgress?.(Math.min(todo.length, i + CHUNK), todo.length);
    await nextFrame();
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: CACHE_VERSION, byKey: keep }));
  } catch {
    // Too big or blocked: rebuilt next time.
  }
  const out = new Map<string, CompactRunSummary>();
  for (const run of runs) {
    const s = keep[keyOf(run)];
    if (s) out.set(run.id, s);
  }
  return out;
}
