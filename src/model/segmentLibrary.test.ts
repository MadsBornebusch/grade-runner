import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { buildSegmentLibrary } from "./segmentLibrary";

function course(specs: Array<Partial<CourseSegment>>): CourseSegment[] {
  let cumulative = 0;
  return specs.map((spec, i) => {
    const distance3D = spec.distance3D ?? 50;
    cumulative += distance3D;
    return {
      index: i,
      cumulativeDistance3D: cumulative,
      distanceHorizontal: distance3D,
      distance3D,
      elevation: 0,
      gradient: 0,
      time: null,
      dtS: 25,
      paused: false,
      heartRateBpm: null,
      powerWatts: null,
      ...spec,
    };
  });
}

describe("buildSegmentLibrary", () => {
  it("tags every segment with its source run's id", () => {
    const library = buildSegmentLibrary(
      [
        { runId: "run-a", segments: course([{ gradient: 0.1 }, { gradient: 0.1 }]) },
        { runId: "run-b", segments: course([{ gradient: -0.1 }, { gradient: -0.1 }]) },
      ],
      { minDistanceM: 0, minTimeS: 0 },
    );
    expect(library).toHaveLength(2);
    expect(library[0].runId).toBe("run-a");
    expect(library[1].runId).toBe("run-b");
  });

  it("returns an empty library for an empty run list", () => {
    expect(buildSegmentLibrary([])).toEqual([]);
  });

  it("drops short runs the same way buildMonotonicSegments does on its own", () => {
    const library = buildSegmentLibrary([{ runId: "run-a", segments: course([{ gradient: 0.1, distance3D: 20, dtS: 8 }]) }]);
    expect(library).toEqual([]);
  });
});
