// PLAN.md §14 Plan B, Stage 3: assembles a cross-run segment library by
// tagging each monotonic segment with its source run's id -- addresses the
// gap flagged when Stage 2 shipped (buildMonotonicSegments' own output has
// no run-of-origin field, since it operates one activity at a time and
// can't know its own id). Needed specifically for this session's own
// clustering landmine: segments within a run are autocorrelated, so any
// downstream fit needs to know which segments came from the same run to
// count informative runs (not just segments) and avoid treating pseudo-
// replicated data as independent.

import type { CourseSegment } from "../gpx/pipeline";
import { buildMonotonicSegments, type MonotonicSegment, type MonotonicSegmentOptions } from "./monotonicSegments";

export interface TaggedMonotonicSegment extends MonotonicSegment {
  /** Identifies the source run this segment came from -- the clustering
   * unit for any downstream fit (see module doc). Opaque to this module;
   * callers typically use a Strava id or stored-run id. */
  runId: string;
}

export interface LibraryRunInput {
  runId: string;
  segments: CourseSegment[];
}

/**
 * Runs buildMonotonicSegments per input run and flattens the results into
 * one tagged array, in input order. `options` is shared across every run
 * (the same segmentation/feature-extraction settings for the whole
 * library) -- pass per-run options by calling buildMonotonicSegments
 * directly if that's ever needed instead.
 */
export function buildSegmentLibrary(
  runs: LibraryRunInput[],
  options: MonotonicSegmentOptions = {},
): TaggedMonotonicSegment[] {
  const library: TaggedMonotonicSegment[] = [];
  for (const run of runs) {
    for (const segment of buildMonotonicSegments(run.segments, options)) {
      library.push({ ...segment, runId: run.runId });
    }
  }
  return library;
}
