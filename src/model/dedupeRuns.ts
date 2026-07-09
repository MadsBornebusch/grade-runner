// Detects runs that are almost certainly the same underlying activity
// imported twice under different ids -- e.g. a manual GPX upload (random id)
// and a later Strava backfill of the same run (stable "strava:<id>") don't
// share a key, so runLibrary.ts's upsert-by-id dedup never catches this
// case (it only catches the same Strava activity imported twice). Matches
// on the same calendar day plus distance/duration within a generous
// tolerance -- GPX-computed distance and Strava's own reported distance can
// differ slightly even for the same activity. Heuristic, not exact --
// flagged for the user to confirm before anything is deleted, never
// auto-removed.

import { runPipeline } from "../gpx/pipeline";
import type { StoredRun } from "../storage/runLibrary";

interface RunSignature {
  dateKey: string;
  distanceKm: number;
  durationH: number;
}

function runSignature(run: StoredRun): RunSignature | null {
  let dateKey = run.date?.slice(0, 10);
  let distanceKm = run.distanceKm;
  let durationH = run.durationS !== undefined ? run.durationS / 3600 : undefined;

  if (run.points !== null && run.points.length > 0) {
    const firstTime = run.points[0].time;
    const lastTime = run.points[run.points.length - 1].time;
    dateKey ??= firstTime?.toISOString().slice(0, 10);
    if (distanceKm === undefined) distanceKm = runPipeline(run.points).totalDistance3D / 1000;
    if (durationH === undefined && firstTime && lastTime) {
      durationH = (lastTime.getTime() - firstTime.getTime()) / 3_600_000;
    }
  }

  if (dateKey === undefined || distanceKm === undefined || durationH === undefined) return null;
  return { dateKey, distanceKm, durationH };
}

const DISTANCE_TOLERANCE_KM = 1;
// Generous on purpose: a GPX-sourced signature's duration is raw elapsed
// time (first point to last), while Strava's durationS is *moving* time
// (excludes auto-detected rest stops) -- for a multi-hour ultra with aid
// stations, those two numbers for the *same* activity can legitimately
// differ by well more than a couple of minutes. Same calendar day + distance
// within DISTANCE_TOLERANCE_KM already do most of the discriminating work;
// duration here is a corroborating signal, not the primary one.
const DURATION_TOLERANCE_H = 0.5;

function signaturesMatch(a: RunSignature, b: RunSignature): boolean {
  return (
    a.dateKey === b.dateKey &&
    Math.abs(a.distanceKm - b.distanceKm) <= DISTANCE_TOLERANCE_KM &&
    Math.abs(a.durationH - b.durationH) <= DURATION_TOLERANCE_H
  );
}

/** Ranks how complete a run's stored data is, to pick which duplicate to
 * keep -- prefers full points over summary-only, then Strava-sourced
 * (richer metadata: elevation, avg HR/power) over a bare manual upload. */
function completenessScore(run: StoredRun): number {
  return (run.points !== null ? 2 : 0) + (run.stravaId !== undefined ? 1 : 0);
}

export interface DedupeResult {
  kept: StoredRun[];
  /** Groups of 2+ runs judged to be the same underlying activity; the first
   * entry in each group is the one `kept`, the rest are the redundant
   * copies still sitting in storage. */
  duplicateGroups: StoredRun[][];
}

export function dedupeStoredRuns(runs: StoredRun[]): DedupeResult {
  const withSignatures = runs.map((run) => ({ run, signature: runSignature(run) }));
  const used = new Set<string>();
  const kept: StoredRun[] = [];
  const duplicateGroups: StoredRun[][] = [];

  for (let i = 0; i < withSignatures.length; i++) {
    if (used.has(withSignatures[i].run.id)) continue;
    const { run, signature } = withSignatures[i];
    used.add(run.id);

    if (!signature) {
      kept.push(run);
      continue;
    }

    const group = [run];
    for (let j = i + 1; j < withSignatures.length; j++) {
      const other = withSignatures[j];
      if (used.has(other.run.id) || !other.signature) continue;
      if (signaturesMatch(signature, other.signature)) {
        group.push(other.run);
        used.add(other.run.id);
      }
    }

    group.sort((a, b) => completenessScore(b) - completenessScore(a));
    kept.push(group[0]);
    if (group.length > 1) duplicateGroups.push(group);
  }

  return { kept, duplicateGroups };
}
