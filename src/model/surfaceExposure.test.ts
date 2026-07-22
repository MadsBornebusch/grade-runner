import { describe, expect, it } from "vitest";
import type { CourseSegment } from "../gpx/pipeline";
import { attachSurfaceData, type ValhallaSurfaceEdge } from "./surfaceExposure";

function segment(overrides: Partial<CourseSegment> = {}): CourseSegment {
  return {
    index: 0,
    cumulativeDistance3D: 0,
    distanceHorizontal: 50,
    distance3D: 50,
    elevation: 0,
    gradient: 0,
    time: null,
    dtS: 25,
    paused: false,
    heartRateBpm: null,
    powerWatts: null,
    ...overrides,
  };
}

/** Ten 100m segments, cumulativeDistance3D 100..1000 -- a clean 1km course
 * for exercising attachSurfaceData's distance-fraction mapping. */
function makeCourse(): CourseSegment[] {
  return Array.from({ length: 10 }, (_, i) =>
    segment({ index: i, cumulativeDistance3D: (i + 1) * 100, distance3D: 100 }),
  );
}

describe("attachSurfaceData", () => {
  it("classifies segments unpaved/paved by matching Valhalla edges at the same total distance", () => {
    const segments = makeCourse();
    // First half gravel (unpaved), second half paved -- Valhalla's own
    // total (1km) matches ours exactly here, no scaling needed.
    const edges: ValhallaSurfaceEdge[] = [
      { surface: "gravel", length: 0.5 },
      { surface: "paved_smooth", length: 0.5 },
    ];
    const result = attachSurfaceData(segments, edges);
    expect(result.slice(0, 5).every((s) => s.surfaceUnpaved === true)).toBe(true);
    expect(result.slice(5).every((s) => s.surfaceUnpaved === false)).toBe(true);
  });

  it("scales when Valhalla's own matched total differs from this course's own total", () => {
    const segments = makeCourse(); // our total: 1000m == 1km
    // Valhalla only matched 0.8km total (map-matching shortfall) -- first
    // half of ITS distance is unpaved, which should still land on roughly
    // the first half of OUR segments once scaled.
    const edges: ValhallaSurfaceEdge[] = [
      { surface: "dirt", length: 0.4 },
      { surface: "paved", length: 0.4 },
    ];
    const result = attachSurfaceData(segments, edges);
    expect(result[0].surfaceUnpaved).toBe(true);
    expect(result[9].surfaceUnpaved).toBe(false);
  });

  it("leaves surfaceUnpaved undefined (not false) when there are no edges at all", () => {
    const segments = makeCourse();
    const result = attachSurfaceData(segments, []);
    expect(result.every((s) => s.surfaceUnpaved === undefined)).toBe(true);
  });

  it("treats paved_smooth/paved/paved_rough and unrecognized surfaces as paved", () => {
    const segments = makeCourse();
    const edges: ValhallaSurfaceEdge[] = [{ surface: "paved_rough", length: 1.0 }];
    const result = attachSurfaceData(segments, edges);
    expect(result.every((s) => s.surfaceUnpaved === false)).toBe(true);
  });
});
