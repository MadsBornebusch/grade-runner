import { runPipeline } from "../gpx/pipeline";
import { STEEP_DESCENT_GRADE } from "../model/descentImpact";
import type { CourseSegment } from "../gpx/pipeline";
import type { StoredCourse } from "../storage/courseLibrary";
import type { GoalRaceSettings } from "../storage/planSettings";
import type { FormInputs } from "./formInputs";
import { predictFinishS } from "./solverInputs";

/** The settings fields the race prediction reads; a change re-predicts. */
export function predictionKey(formInputs: FormInputs): string {
  const { splitLengthKm: _split, ...rest } = formInputs;
  // The version bumps when courseFacts changes, to recompute stored facts.
  return JSON.stringify([2, rest]);
}

/** Course facts and the finish prediction for a goal race. A 100 km course
 * takes a second or two to solve, so callers run this off the first paint. */
export function courseFacts(course: StoredCourse, formInputs: FormInputs): Pick<GoalRaceSettings, "distanceKm" | "descentM" | "steepDescentM" | "predictedFinishS"> {
  const result = runPipeline(course.points, { segmentLengthM: formInputs.segmentLengthM, smoothingWindowM: formInputs.smoothingWindowM });
  return {
    distanceKm: result.totalDistance3D / 1000,
    descentM: result.hasElevation ? result.totalElevationLoss : null,
    steepDescentM: result.hasElevation ? courseSteepDescent(result.segments) : null,
    predictedFinishS: predictFinishS(result.segments, formInputs),
  };
}

/** Steep descent of a planned course. descentImpact.ts's version skips
 * segments without timestamps (it's for recorded runs), and a course has
 * none, so this sums the elevation drops directly. */
export function courseSteepDescent(segments: CourseSegment[], steeperThan = STEEP_DESCENT_GRADE): number {
  let total = 0;
  for (let i = 1; i < segments.length; i++) {
    const drop = segments[i - 1].elevation - segments[i].elevation;
    if (drop > 0 && segments[i].gradient < steeperThan) total += drop;
  }
  return total;
}
